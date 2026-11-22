import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { MatchResult, State } from '../core/types'
import { utf8Bytes } from '../core/utf8'
import { ready, runOf, send } from '../testing/inputs'
import { runInMode, runState } from '../testing/state'
import { blindStart, runOfMode, scored } from '../testing/timers'
import {
	END_GAME_TEXT_MAX,
	JOKERS_TEXT_MAX,
	abandonedResult,
	agreedResult,
	decideMatch,
	drawResult,
	dropPlayer,
	leaveBeforeRun,
	restartedResult,
	setResult,
	settleWaitingDeaths,
	winResult,
} from './finish'

const PLAYERS = ['ann', 'bob']
const STATS = { rerollCount: 2, rerollCostTotal: 10 }
const endGame = {
	kind: 'endGame',
	jokers: 'j_joker',
	deck: 'b_red',
	stats: STATS,
}

const preRun = (players = PLAYERS): State => ({
	...runState(players),
	run: null,
})

// A player who left the lobby mid-run, decided the way the shell does it.
const leaveRun = (
	state: State,
	player: string,
	now: number,
	ranked: boolean,
): State =>
	decideMatch(
		settleWaitingDeaths(
			dropPlayer(
				decideMatch(settleWaitingDeaths(state, ranked), ranked),
				player,
				'left',
				now,
			),
			ranked,
		),
		ranked,
	)

const forfeit = (state: State, player: string): State =>
	send(state, player, { kind: 'forfeit' }).state
const vote = (state: State, player: string, topic: string, yes: boolean) =>
	send(state, player, { kind: 'vote', topic, yes })

const RESULTS: MatchResult[] = [
	winResult(['ann'], true),
	drawResult(false),
	agreedResult(),
	abandonedResult(),
	{ kind: 'contested' },
	restartedResult(),
]
const anyResult = fc.constantFrom(...RESULTS)

describe('the results', () => {
	it.each([
		[
			'win',
			winResult(['bob', 'ann'], true),
			{ kind: 'win', winners: ['ann', 'bob'], rating: 'rated' },
		],
		['draw', drawResult(false), { kind: 'draw', rating: 'unrated' }],
		['agreed', agreedResult(), { kind: 'agreed' }],
		['abandoned', abandonedResult(), { kind: 'abandoned' }],
		['contested', { kind: 'contested' }, { kind: 'contested' }],
		['restarted', restartedResult(), { kind: 'restarted' }],
	])('%s has only its own fields', (_name, made, expected) => {
		expect(made).toEqual(expected)
	})

	it('result_has_one_writer: the first result stays, whatever follows', () => {
		fc.assert(
			fc.property(
				fc.array(anyResult, { minLength: 1, maxLength: 6 }),
				(results) => {
					const out = results.reduce(setResult, runState(PLAYERS))
					expect(out.result).toEqual(results[0])
				},
			),
		)
	})

	it('result_is_frozen: once set, nothing the match does changes it', () => {
		fc.assert(
			fc.property(anyResult, (result) => {
				const decided = setResult(runState(PLAYERS), result)
				expect(decideMatch(decided, true)).toEqual(decided)
				expect(dropPlayer(decided, 'ann', 'forfeit', 0)).toEqual(decided)
				expect(leaveRun(decided, 'ann', 0, true)).toEqual(decided)
				expect(
					leaveBeforeRun({ ...decided, run: null }, ['ann'], true),
				).toEqual({ ...decided, run: null })
				expect(send(decided, 'ann', { kind: 'forfeit' }).state.result).toEqual(
					result,
				)
				expect(
					send(decided, 'ann', { kind: 'vote', topic: 'seed', yes: true }).state
						.result,
				).toEqual(result)
			}),
		)
	})

	it('contest_outranks_every_ending: later endings leave a contest alone', () => {
		const contested = setResult(runState(PLAYERS), { kind: 'contested' })
		fc.assert(
			fc.property(fc.array(anyResult, { maxLength: 5 }), (results) => {
				expect(results.reduce(setResult, contested).result).toEqual({
					kind: 'contested',
				})
			}),
		)
		const left = leaveBeforeRun({ ...contested, run: null }, ['ann'], true)
		expect(left.result).toEqual({ kind: 'contested' })
	})
})

describe('leaving before the run', () => {
	it.each([
		['two players', PLAYERS, ['bob']],
		['both leave', PLAYERS, ['bob', 'ann']],
		['three players', ['ann', 'bob', 'cat'], ['bob']],
	])(
		'ranked_draft_leave_abandoned: a ranked leave, %s, ends as abandoned',
		(_name, players, leavers) => {
			expect(leaveBeforeRun(preRun(players), leavers, true).result).toEqual({
				kind: 'abandoned',
			})
		},
	)

	it('casual_prerun_leave_agreed: a casual match ends as agreed', () => {
		expect(leaveBeforeRun(preRun(PLAYERS), ['bob'], false).result).toEqual({
			kind: 'agreed',
		})
	})

	it('does nothing once the run exists or with nobody leaving', () => {
		const running = runState(PLAYERS)
		expect(leaveBeforeRun(running, ['bob'], true)).toEqual(running)
		expect(leaveBeforeRun(preRun(), [], true)).toEqual(preRun())
	})
})

describe('forfeit', () => {
	it('leave_is_forfeit: the player is out of the run and the other wins when decided', () => {
		const state = forfeit(runState(PLAYERS), 'bob')
		expect(runOf(state).lives.bob.status).toBe('forfeited')
		expect(state.result).toBeNull()
		const decided = decideMatch(state, true)
		expect(decided.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
		expect(runOf(decided).places).toEqual({ ann: 1, bob: 2 })
		expect(decideMatch(state, false).result).toMatchObject({
			rating: 'unrated',
		})
	})

	it('is refused a second time and once decided', () => {
		const once = forfeit(runState(PLAYERS), 'bob')
		const again = send(once, 'bob', { kind: 'forfeit' })
		expect(again.refusals).toEqual(['already_out'])
		const decided = setResult(runState(PLAYERS), agreedResult())
		expect(send(decided, 'bob', { kind: 'forfeit' }).refusals).toEqual([
			'already_decided',
		])
	})

	it('a player with no lives left cannot forfeit (a dead player is out already)', () => {
		const state = runState(['ann', 'bob', 'cat'])
		const run = runOf(state)
		const dead: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, cat: { ...run.lives.cat, lives: 0 } },
			},
		}
		const out = send(dead, 'cat', { kind: 'forfeit' })
		expect(out.refusals).toEqual(['already_out'])
		expect(runOf(out.state).lives.cat).toEqual(runOf(dead).lives.cat)
	})

	it('ranked_all_forfeit_abandoned: everyone gone with nobody having won is abandoned', () => {
		let state = forfeit(runState(PLAYERS), 'ann')
		state = forfeit(state, 'bob')
		expect(state.result).toBeNull()
		expect(decideMatch(state, true).result).toEqual({
			kind: 'abandoned',
		})
	})

	it('a winner decided before the last player goes stays a win, never abandoned', () => {
		const first = decideMatch(forfeit(runState(PLAYERS), 'ann'), true)
		expect(first.result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'rated',
		})
		const after = decideMatch(forfeit(first, 'bob'), true)
		expect(after.result).toEqual(first.result)
	})

	it('P8 a player who leaves before the tick takes nothing from the winner the forfeit made', () => {
		const state = forfeit(runState(PLAYERS), 'bob')
		const dropped = dropPlayer(state, 'ann', 'left', 5)
		expect(runOf(dropped).lives.ann.status).toBe('left')
		expect(dropped.result).toBeNull()
		expect(decideMatch(dropped, true).result).toEqual({
			kind: 'abandoned',
		})
		const out = leaveRun(state, 'ann', 5, true)
		expect(out.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
		expect(runOf(out).places).toEqual({ ann: 1, bob: 2 })
	})

	it('a player who leaves after beating the blind still wins the death that waited on them', () => {
		const base = runState(PLAYERS)
		const run = runOf(base)
		const dying: State = {
			...base,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, lives: 0 } },
				players: {
					...run.players,
					bob: {
						...run.players.bob,
						results: { '1:Small': { result: 'beaten' } },
					},
				},
				waitingDeaths: [
					{ playerId: 'ann', blindKey: '1:Small', waitingFor: ['bob'] },
				],
			},
		}
		expect(leaveRun(dying, 'bob', 0, true).result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'rated',
		})
	})

	it('a player who left is out the same way', () => {
		const state = dropPlayer(runState(PLAYERS), 'bob', 'left', 0)
		expect(runOf(state).lives.bob.status).toBe('left')
		expect(runOf(state).lives.ann.status).toBe('playing')
		expect(dropPlayer(state, 'bob', 'left', 0)).toEqual(state)
	})

	it('three players: one forfeit leaves the match undecided', () => {
		const state = forfeit(runState(['ann', 'bob', 'cat']), 'cat')
		expect(decideMatch(state, true).result).toBeNull()
	})

	it.each(['forfeit', 'left'] as const)(
		'a player who %s as the last one the PvP blind waits on closes the PvP blind',
		(how) => {
			const players = ['ann', 'bob', 'cat']
			let state = runOfMode(players, 'royale')
			for (const player of players) state = ready(state, player).state
			for (const player of players) state = blindStart(state, player)
			state = scored(state, 'ann', '5', 0)
			state = scored(state, 'bob', '3', 0)
			expect(runOf(state).currentPvpBlind).not.toBeNull()
			const dropped = dropPlayer(state, 'cat', how, 5)
			expect(runOf(dropped).currentPvpBlind).toBeNull()
			expect(runOf(dropped).finishedPvpBlinds).toHaveLength(1)
		},
	)
})

describe('votes', () => {
	it('newest wins: yes adds the player once, no takes them out', () => {
		let state = vote(runState(PLAYERS), 'ann', 'draw', true).state
		state = vote(state, 'ann', 'draw', true).state
		expect(runOf(state).votes).toEqual({ draw: ['ann'], seed: [] })
		state = vote(state, 'ann', 'draw', false).state
		expect(runOf(state).votes).toEqual({ draw: [], seed: [] })
	})

	it('seed_vote_restarts_without_host: every player in the run saying yes restarts when decided', () => {
		let state = vote(runState(PLAYERS), 'ann', 'seed', true).state
		state = vote(state, 'bob', 'seed', true).state
		expect(state.result).toBeNull()
		expect(decideMatch(state, true).result).toEqual({
			kind: 'restarted',
		})
	})

	it('a forfeited player is not waited on for a seed vote', () => {
		let state = forfeit(runState(['ann', 'bob', 'cat']), 'cat')
		state = vote(state, 'ann', 'seed', true).state
		state = vote(state, 'bob', 'seed', true).state
		expect(decideMatch(state, true).result).toEqual({
			kind: 'restarted',
		})
	})

	it('a draw vote that everyone agrees to draws, as rated as the lobby is', () => {
		let state = vote(runState(PLAYERS), 'ann', 'draw', true).state
		state = vote(state, 'bob', 'draw', true).state
		expect(state.result).toBeNull()
		expect(decideMatch(state, true).result).toEqual({
			kind: 'draw',
			rating: 'rated',
		})
		expect(decideMatch(state, false).result).toEqual({
			kind: 'draw',
			rating: 'unrated',
		})
	})

	it('P1 a winner is checked before any vote: a draw vote then a forfeit is a win', () => {
		let state = vote(runState(PLAYERS), 'ann', 'draw', true).state
		state = forfeit(state, 'bob')
		expect(decideMatch(state, true).result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
	})

	it('a draw or seed vote needs every player in the run, not some of them', () => {
		for (const topic of ['draw', 'seed']) {
			let two = vote(runState(PLAYERS), 'ann', topic, true).state
			expect(decideMatch(two, true).result).toBeNull()
			let three = vote(
				runState(['ann', 'bob', 'cat']),
				'ann',
				topic,
				true,
			).state
			three = vote(three, 'bob', topic, true).state
			expect(decideMatch(three, true).result).toBeNull()
			two = vote(two, 'bob', topic, true).state
			expect(decideMatch(two, true).result).not.toBeNull()
		}
	})

	it('Teams with both teams out at once is a draw, as rated as the lobby is', () => {
		const base = runInMode(['a1', 'a2', 'b1', 'b2'], 'teams', {
			a1: 'A',
			a2: 'A',
			b1: 'B',
			b2: 'B',
		})
		const run = runOf(base)
		const out: State = {
			...base,
			run: { ...run, teamLives: { A: 0, B: 0 } },
		}
		expect(decideMatch(out, true).result).toEqual({
			kind: 'draw',
			rating: 'rated',
		})
		expect(decideMatch(out, false).result).toEqual({
			kind: 'draw',
			rating: 'unrated',
		})
	})

	it('P9 a seed vote from the last player in the run does not restart: they won', () => {
		let state = forfeit(runState(PLAYERS), 'bob')
		state = vote(state, 'ann', 'seed', true).state
		expect(decideMatch(state, true).result).toMatchObject({
			kind: 'win',
		})
	})

	it('votes_need_two: a vote passes only while at least 2 players are in the run', () => {
		const base = forfeit(runState(PLAYERS), 'bob')
		const run = runOf(base)
		const holding: State = {
			...base,
			run: {
				...run,
				votes: { draw: ['ann'], seed: ['ann'] },
				waitingDeaths: [
					{ playerId: 'bob', blindKey: '2:Boss', waitingFor: [] },
				],
			},
		}
		expect(decideMatch(holding, true).result).toBeNull()
	})

	it.each([
		[
			'a player out of the run',
			(s: State) => forfeit(s, 'bob'),
			'bob',
			'eliminated',
		],
		[
			'a decided match',
			(s: State) => setResult(s, agreedResult()),
			'ann',
			'already_decided',
		],
	])('is refused for %s', (_name, change, player, code) => {
		const state = change(runState(PLAYERS))
		const out = vote(state, player, 'draw', true)
		expect(out.refusals).toEqual([code])
		expect(runOf(out.state).votes).toEqual({ draw: [], seed: [] })
	})
})

describe('endGame', () => {
	const out = (): State => forfeit(runState(PLAYERS), 'bob')

	it('is refused while the player is still in the run', () => {
		const refused = send(runState(PLAYERS), 'ann', endGame)
		expect(refused.refusals).toEqual(['still_playing'])
		expect(runOf(refused.state).endGames).toEqual({})
	})

	it('is taken from a player who is out, newest wins', () => {
		let state = send(out(), 'bob', endGame).state
		state = send(state, 'bob', { ...endGame, deck: 'b_blue' }).state
		expect(runOf(state).endGames).toEqual({
			bob: { jokers: 'j_joker', deck: 'b_blue', stats: STATS },
		})
	})

	it('is taken from anyone once the match is decided', () => {
		const state = setResult(runState(PLAYERS), agreedResult())
		expect(runOf(send(state, 'ann', endGame).state).endGames.ann).toBeDefined()
	})

	it.each([
		[
			'too much text',
			{ ...endGame, jokers: 'x'.repeat(END_GAME_TEXT_MAX + 1) },
		],
		['a missing field', { kind: 'endGame', jokers: 'j', deck: 'd' }],
		[
			'a negative count',
			{ ...endGame, stats: { rerollCount: -1, rerollCostTotal: 0 } },
		],
		['an extra field', { ...endGame, extra: 1 }],
	])('refuses %s as a bad body', (_name, body) => {
		const refused = send(out(), 'bob', body)
		expect(refused.refusals).toEqual(['bad_request_body'])
		expect(runOf(refused.state).endGames).toEqual({})
	})

	it.each([
		['', 0],
		['abc', 3],
		['é', 2],
		['€', 3],
		['😀', 4],
		['a€😀', 8],
		['\u007f', 1],
		['\u0080', 2],
		['߿', 2],
		['ࠀ', 3],
		['￿', 3],
		['\u{10000}', 4],
		['\u{10ffff}', 4],
	])('utf8Bytes(%j) is %i', (text, bytes) => {
		expect(utf8Bytes(text)).toBe(bytes)
	})

	it.each([
		['no jokers', { jokers: '', deck: 'b_red' }],
		['no deck', { jokers: 'j_joker', deck: '' }],
		['neither', { jokers: '', deck: '' }],
	])('takes %s as empty text', (_name, text) => {
		const taken = send(out(), 'bob', { ...endGame, ...text })
		expect(taken.refusals).toEqual([])
		expect(runOf(taken.state).endGames.bob).toEqual({ ...text, stats: STATS })
	})
})

describe('jokers on leaving a shop', () => {
	it('is taken from a player still in the run, newest wins', () => {
		let state = send(runState(PLAYERS), 'ann', {
			kind: 'jokers',
			jokers: 'j_a',
		}).state
		state = send(state, 'ann', { kind: 'jokers', jokers: 'j_b' }).state
		state = send(state, 'bob', { kind: 'jokers', jokers: '' }).state
		expect(runOf(state).lastJokers).toEqual({ ann: 'j_b', bob: '' })
	})

	it('is refused with no run', () => {
		const refused = send(preRun(), 'ann', { kind: 'jokers', jokers: 'j_a' })
		expect(refused.refusals).not.toEqual([])
	})

	it.each([
		[
			'too much text',
			{ kind: 'jokers', jokers: 'x'.repeat(JOKERS_TEXT_MAX + 1) },
		],
		['a missing field', { kind: 'jokers' }],
		['an extra field', { kind: 'jokers', jokers: 'j', extra: 1 }],
	])('refuses %s as a bad body', (_name, body) => {
		const refused = send(runState(PLAYERS), 'ann', body)
		expect(refused.refusals).toEqual(['bad_request_body'])
		expect(runOf(refused.state).lastJokers).toEqual({})
	})

	it('does not change an endGame already sent', () => {
		let state = send(forfeit(runState(PLAYERS), 'bob'), 'bob', endGame).state
		state = send(state, 'bob', { kind: 'jokers', jokers: 'j_late' }).state
		expect(runOf(state).endGames.bob.jokers).toBe('j_joker')
	})
})

describe('no client input can throw', () => {
	it('any body for the four kinds is a confirmed input', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('vote', 'forfeit', 'endGame', 'jokers'),
				fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue(), {
					maxKeys: 4,
				}),
				(kind, fields) => {
					const state = runState(PLAYERS)
					const result = send(state, 'ann', { ...fields, kind })
					expect(result.lastNumber).toBe(1)
				},
			),
		)
	})
})
