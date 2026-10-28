import { describe, expect, it } from 'vitest'
import { ServerOp } from '../lobby/protocol'
import { action } from '../lobby/relay'
import {
	type Lobby,
	type Outbound,
	type Step,
	join,
	newLobby,
} from '../lobby/state'
import { setupOf, setupTick } from './setup'

// The Ruleset vote's roll through the real actions, many times over: each vote
// is one chance (spec decision 4), a unanimous vote always wins, and with no
// votes every option has the same chance.

const RULESETS = ['vanilla', 'majorleague', 'balanced', 'expanded']
const ROUNDS = 4000

// A seeded random source (mulberry32), so a failure repeats.
function seeded(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const info = (name: string) => ({
	displayName: name,
	preferredJoker: null,
	mods: null,
})

let random = seeded(1)
function send(
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown = {},
): Step {
	return action(
		lobby,
		from,
		{ cid: `${key}-${from}`, action: key, to: 'server', params },
		{ now: 1000, newSeed: () => 'SEED1234', newId: () => 'RUN', random },
	)
}

type Send = Extract<Outbound, { kind: 'send' }>
function rejection(step: Step): string | undefined {
	const r = step.out.filter(
		(o): o is Send => o.kind === 'send' && o.op === ServerOp.ACTION_REJECTED,
	)[0]
	return r && (r.payload as { reason: string }).reason
}

function started(players: string[]): Lobby {
	let lobby = newLobby({
		code: 'ODDS01',
		modId: 'm',
		maxPlayers: 8,
		creatorId: players[0],
		now: 0,
		graceMs: 10_000,
	})
	for (const id of players) lobby = join(lobby, id, `${id}-s1`, info(id)).lobby
	for (const id of players.slice(1))
		lobby = send(lobby, id, 'mpapi_ready', { ready: true }).lobby
	return send(lobby, players[0], 'mpapi_start_game', { stake: 1 }).lobby
}

// One Ruleset vote in a fresh game: `votes` maps player -> option (a player
// left out does not vote); returns the rolled option.
function rollOnce(players: string[], votes: { [id: string]: string }): string {
	let lobby = started(players)
	lobby = send(lobby, players[0], 'mpapi_setup_vote', {
		id: 'ruleset',
		options: RULESETS,
	}).lobby
	for (const id of Object.keys(votes)) {
		const step = send(lobby, id, 'mpapi_setup_cast', { option: votes[id] })
		expect(rejection(step)).toBeUndefined()
		lobby = step.lobby
	}
	const open = setupOf(lobby.game).open
	if (open) lobby = setupTick(lobby, open.deadline, random).lobby
	const result = setupOf(lobby.game).results.ruleset
	if (!result || result.kind !== 'vote')
		throw new Error('the vote did not close')
	return result.option
}

function tally(players: string[], votes: { [id: string]: string }) {
	const seen: { [option: string]: number } = {}
	for (const option of RULESETS) seen[option] = 0
	for (let i = 0; i < ROUNDS; i++) seen[rollOnce(players, votes)] += 1
	return seen
}

// Within 4 standard deviations of the expected share (a binomial count).
function expectShare(count: number, p: number) {
	const sd = Math.sqrt(ROUNDS * p * (1 - p))
	expect(Math.abs(count - ROUNDS * p)).toBeLessThanOrEqual(4 * sd + 1)
}

describe('the Ruleset vote roll over many games', () => {
	it('gives a 1-1 split an even chance', () => {
		random = seeded(11)
		const seen = tally(['a', 'b'], { a: 'vanilla', b: 'expanded' })
		expectShare(seen.vanilla, 0.5)
		expectShare(seen.expanded, 0.5)
		expect(seen.balanced + seen.majorleague).toBe(0)
	})

	it('gives 2 votes of 3 a 2 in 3 chance', () => {
		random = seeded(22)
		const seen = tally(['a', 'b', 'c'], {
			a: 'balanced',
			b: 'balanced',
			c: 'majorleague',
		})
		expectShare(seen.balanced, 2 / 3)
		expectShare(seen.majorleague, 1 / 3)
		expect(seen.vanilla + seen.expanded).toBe(0)
	})

	it('leaves a player who does not vote out of the roll', () => {
		random = seeded(33)
		// c never votes: the vote closes at its deadline on a's and b's votes.
		const seen = tally(['a', 'b', 'c'], { a: 'vanilla', b: 'expanded' })
		expectShare(seen.vanilla, 0.5)
		expectShare(seen.expanded, 0.5)
		expect(seen.balanced + seen.majorleague).toBe(0)
	})

	it('always gives a unanimous vote the win', () => {
		random = seeded(44)
		for (const option of RULESETS) {
			const seen = tally(['a', 'b'], { a: option, b: option })
			expect(seen[option]).toBe(ROUNDS)
		}
	})

	it('gives every option the same chance when nobody votes', () => {
		random = seeded(55)
		const seen = tally(['a', 'b'], {})
		for (const option of RULESETS) expectShare(seen[option], 1 / 4)
	})
})

describe('votes at the edges', () => {
	it('refuses a changed vote, a vote after the close and an unknown option', () => {
		random = seeded(66)
		let lobby = started(['a', 'b', 'c'])
		lobby = send(lobby, 'a', 'mpapi_setup_vote', {
			id: 'ruleset',
			options: RULESETS,
		}).lobby
		expect(
			rejection(send(lobby, 'b', 'mpapi_setup_cast', { option: 'chaos' })),
		).toBe('bad_params')
		expect(rejection(send(lobby, 'b', 'mpapi_setup_cast', {}))).toBe(
			'bad_params',
		)
		lobby = send(lobby, 'b', 'mpapi_setup_cast', { option: 'vanilla' }).lobby
		expect(
			rejection(send(lobby, 'b', 'mpapi_setup_cast', { option: 'expanded' })),
		).toBe('already_voted')
		const open = setupOf(lobby.game).open
		if (!open) throw new Error('no open vote')
		lobby = setupTick(lobby, open.deadline, random).lobby
		expect(setupOf(lobby.game).results.ruleset).toMatchObject({
			option: 'vanilla',
		})
		expect(
			rejection(send(lobby, 'c', 'mpapi_setup_cast', { option: 'expanded' })),
		).toBe('no_vote')
		expect(setupOf(lobby.game).results.ruleset).toMatchObject({
			option: 'vanilla',
		})
	})
})
