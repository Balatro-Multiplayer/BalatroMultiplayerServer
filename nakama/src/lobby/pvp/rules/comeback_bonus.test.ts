// The comeback bonus: one `comebackBonus` inbox item for every life a player loses, whatever
// took it, and for nobody else. The mod pays the gold at its next PvP blind eval. Where this
// differs from main's action_player_info count: a gained life gives nothing, two lives lost
// between two updates give two, and the bonus is always on.
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { visibleInbox } from '../core/inbox'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import {
	reportedRunInMode as runInMode,
	reportedRunState as runState,
} from '../testing/state'

import type { InboxItem, State } from '../core/types'
import { dropPlayer } from '../inputs/finish'
import { runOutTimers } from '../inputs/timer_run_out'
import { BASE, anteStarted, livesOf, pvpStarted } from '../testing/timers'
import { type PvpLifePlayer, comebackBonusOwners } from './lives'

const DUEL = ['ann', 'bob']

const bonus = (itemNumber: number): InboxItem => ({
	itemNumber,
	from: null,
	effect: 'comebackBonus',
	amount: 1,
})

const bonusesOf = (state: State, player: string): InboxItem[] =>
	runOf(state).players[player].inbox.filter(
		(item) => item.effect === 'comebackBonus',
	)

function atAnte(players: string[], ante: number, state?: State): State {
	return players.reduce(
		(next, player) =>
			send(next, player, { kind: 'progress', ante, location: 'shop' }).state,
		state ?? runState(players),
	)
}

const blindResult = (blindKey: string, pvpBlindLost: boolean) => ({
	kind: 'blindResult',
	blindKey,
	result: pvpBlindLost ? 'lost' : 'failed on the clock',
})

function withLives(state: State, player: string, lives: number): State {
	const run = runOf(state)
	return {
		...state,
		run: {
			...run,
			lives: { ...run.lives, [player]: { ...run.lives[player], lives } },
		},
	}
}

function withTeamPool(state: State): State {
	return { ...state, run: { ...runOf(state), teamLives: { A: 4, B: 4 } } }
}

const FOUR = ['ann', 'bob', 'cat', 'dan']
const TEAMS = { ann: 'A', bob: 'A', cat: 'B', dan: 'B' } as const

// Every player reports one hand at their score, then plays it.
function playPvpBlindOut(
	state: State,
	scores: { [player: string]: string },
): State {
	let next = state
	for (const player of Object.keys(scores)) next = ready(next, player).state
	for (const player of Object.keys(scores))
		next = send(next, player, {
			kind: 'blindStart',
			blindKey: BLIND,
			handsLeft: 1,
			score: scores[player],
		}).state
	for (const player of Object.keys(scores))
		next = send(next, player, {
			kind: 'handScored',
			blindKey: BLIND,
			handsLeft: 0,
			score: scores[player],
		}).state
	return next
}

const withOptions = (
	state: State,
	rules: Partial<ReturnType<typeof runOf>['rules']>,
): State => ({
	...state,
	run: { ...runOf(state), rules: { ...runOf(state).rules, ...rules } },
})

// main networking/action_handlers.lua:496 (gold_on_life_loss), pvp_api/referee.lua:1950
// (death_on_round_loss, now death_on_normal_blind_loss).
describe('the lobby options gold_on_life_loss and death_on_normal_blind_loss', () => {
	const lostNormalBlind = (rules: Partial<ReturnType<typeof runOf>['rules']>) =>
		send(
			withOptions(atAnte(DUEL, 2), rules),
			'ann',
			blindResult('2:Small', true),
		).state
	const lostPvpBlind = (rules: Partial<ReturnType<typeof runOf>['rules']>) =>
		playPvpBlindOut(withOptions(runState(DUEL), rules), { ann: '1', bob: '9' })

	it.each([
		['a lost normal blind', lostNormalBlind],
		['a lost PvP blind', lostPvpBlind],
	])('gold on: %s gives one item per life lost', (_name, make) => {
		expect(bonusesOf(make({ lifeLossGold: 'paid' }), 'ann')).toEqual([bonus(1)])
	})

	it.each([
		['a lost normal blind', lostNormalBlind],
		['a lost PvP blind', lostPvpBlind],
	])('gold off: %s still costs the life and gives no item', (_name, make) => {
		const state = make({ lifeLossGold: 'none' })
		expect(livesOf(state, 'ann')).toBe(3)
		expect(runOf(state).players.ann.inbox).toEqual([])
	})

	it('gold off: an Ante run-out gives no item', () => {
		const state = runOutTimers(
			withOptions(anteStarted(), { lifeLossGold: 'none' }),
			BASE,
		)
		expect(livesOf(state, 'bob')).toBe(3)
		expect(bonusesOf(state, 'bob')).toEqual([])
	})

	it('deaths on: a failed normal blind costs a life', () => {
		expect(livesOf(lostNormalBlind({ failedBlindLife: 'costs' }), 'ann')).toBe(
			3,
		)
	})

	it('deaths off: a failed normal blind costs nothing and gives no item', () => {
		const state = lostNormalBlind({ failedBlindLife: 'free' })
		expect(livesOf(state, 'ann')).toBe(4)
		expect(runOf(state).players.ann.inbox).toEqual([])
	})

	it('deaths off: the lost PvP blind still costs its life', () => {
		expect(livesOf(lostPvpBlind({ failedBlindLife: 'free' }), 'ann')).toBe(3)
	})

	it('deaths off: a failed PvP blind (a lost action on it) costs nothing', () => {
		const state = send(
			withOptions(runState(DUEL), { failedBlindLife: 'free' }),
			'ann',
			blindResult(BLIND, true),
		).state
		expect(livesOf(state, 'ann')).toBe(4)
	})

	it('deaths off: an Ante run-out still costs a life', () => {
		const state = runOutTimers(
			withOptions(anteStarted(), { failedBlindLife: 'free' }),
			BASE,
		)
		expect(livesOf(state, 'bob')).toBe(3)
	})
})

describe('the comeback bonus item, by kind of life loss', () => {
	it.each([
		[
			'a lost PvP blind',
			() => playPvpBlindOut(runState(DUEL), { ann: '1', bob: '9' }),
			'ann',
			'bob',
		],
		[
			'a lost normal blind',
			() => send(atAnte(DUEL, 2), 'ann', blindResult('2:Small', true)).state,
			'ann',
			'bob',
		],
		[
			'a lost PvP blind, then the same blind failed again',
			() =>
				send(
					playPvpBlindOut(runState(DUEL), { ann: '1', bob: '9' }),
					'ann',
					blindResult(BLIND, true),
				).state,
			'ann',
			'bob',
		],
		[
			'an Ante timer run-out',
			() => runOutTimers(anteStarted(), BASE),
			'bob',
			'ann',
		],
		[
			'a PvP timer run-out, the loser never having sent anything since',
			() => runOutTimers(pvpStarted(), 61_000),
			'bob',
			'ann',
		],
	])(
		'%s: the loser gets one item, the other player none',
		(_name, make, loser, other) => {
			const state = make()
			expect(livesOf(state, loser)).toBe(3)
			expect(runOf(state).players[loser].inbox).toEqual([bonus(1)])
			expect(runOf(state).players[other].inbox).toEqual([])
		},
	)

	it('a forgiven Ante run-out costs no life and gives no item', () => {
		const forgiving = anteStarted()
		const state = runOutTimers(
			{
				...forgiving,
				run: {
					...runOf(forgiving),
					rules: { ...runOf(forgiving).rules, timerForgiveness: 1 },
				},
			},
			BASE,
		)
		expect(livesOf(state, 'bob')).toBe(4)
		expect(runOf(state).players.bob.inbox).toEqual([])
	})

	it('a lost blind that is not lost for the PvP blind gives no item', () => {
		const state = send(
			atAnte(DUEL, 2),
			'ann',
			blindResult('2:Small', false),
		).state
		expect(runOf(state).players.ann.inbox).toEqual([])
	})

	it('the last life still gets its item, and the next loss nothing more', () => {
		const state = send(
			withLives(atAnte(DUEL, 2), 'ann', 1),
			'ann',
			blindResult('2:Small', true),
		).state
		expect(livesOf(state, 'ann')).toBe(0)
		expect(bonusesOf(state, 'ann')).toEqual([bonus(1)])
		const more = send(state, 'ann', blindResult('2:Big', true)).state
		expect(bonusesOf(more, 'ann')).toEqual([bonus(1)])
	})

	it.each(['forfeit', 'left'] as const)(
		'a player who drops out by %s gives nobody an item',
		(how) => {
			const state = dropPlayer(runState(DUEL), 'bob', how, 0)
			expect(runOf(state).players.ann.inbox).toEqual([])
			expect(runOf(state).players.bob.inbox).toEqual([])
		},
	)

	it('a last life lost on a normal blind opens a waiting death and still gives its item', () => {
		const state = send(
			withLives(atAnte(DUEL, 2), 'ann', 1),
			'ann',
			blindResult('2:Small', true),
		).state
		expect(runOf(state).waitingDeaths.map((death) => death.playerId)).toEqual([
			'ann',
		])
		expect(bonusesOf(state, 'ann')).toEqual([bonus(1)])
	})

	it('a life lost while the player is away waits in its inbox, however many views pass', () => {
		const state = runOutTimers(pvpStarted(), 61_000)
		expect(visibleInbox(state, 'bob').inbox).toEqual([bonus(1)])
		expect(visibleInbox(state, 'bob').inboxNewest).toBe(1)
		const seen = send(state, 'ann', {
			kind: 'progress',
			ante: 2,
			location: 'shop',
		}).state
		expect(visibleInbox(seen, 'bob').inbox).toEqual([bonus(1)])
	})

	it('Royale: every player who lost the PvP blind gets one item, the winner none', () => {
		const three = ['ann', 'bob', 'cat']
		const base = runState(three)
		const royale: State = {
			...base,
			run: {
				...runOf(base),
				rules: { ...runOf(base).rules, mode: 'royale', startedCount: 3 },
			},
		}
		const state = playPvpBlindOut(royale, { ann: '1', bob: '2', cat: '90' })
		const run = runOf(state)
		const losers = run.finishedPvpBlinds[0].losers
		expect(losers.length).toBeGreaterThan(0)
		for (const player of three)
			expect(bonusesOf(state, player)).toEqual(
				losers.includes(player) ? [bonus(1)] : [],
			)
	})

	it('Manhunt: a Hunter losing a blind gets an item; a voucher life gives only its own item', () => {
		const roster = { ann: 'RUNNER', bob: 'HUNTER', cat: 'HUNTER' } as const
		const hunt = runInMode(['ann', 'bob', 'cat'], 'manhunt', roster)
		const hunted = send(hunt, 'ann', {
			kind: 'voucher',
			voucherKey: 'v_hieroglyph',
		}).state
		expect(runOf(hunted).players.bob.inbox.map((i) => i.effect)).toEqual([
			'voucherLife',
		])
		const lost = send(
			atAnte(['ann', 'bob', 'cat'], 2, hunted),
			'bob',
			blindResult('2:Small', true),
		).state
		expect(runOf(lost).players.bob.inbox.map((i) => i.effect)).toEqual([
			'voucherLife',
			'comebackBonus',
		])
		expect(bonusesOf(lost, 'bob')[0].itemNumber).toBe(2)
		expect(runOf(lost).players.cat.inbox.map((i) => i.effect)).toEqual([
			'voucherLife',
		])
	})

	it('Teams: a pool loss in a lost PvP blind gives each member of the losing team one item', () => {
		const base = withTeamPool(runInMode(FOUR, 'teams', TEAMS))
		const state = playPvpBlindOut(base, {
			ann: '1',
			bob: '1',
			cat: '50',
			dan: '50',
		})
		expect(runOf(state).teamLives).toEqual({ A: 3, B: 4 })
		expect(bonusesOf(state, 'ann')).toEqual([bonus(1)])
		expect(bonusesOf(state, 'bob')).toEqual([bonus(1)])
		expect(bonusesOf(state, 'cat')).toEqual([])
		expect(bonusesOf(state, 'dan')).toEqual([])
	})

	it('Teams: two teammates failing one ante cost the pool one life and give one item each, not two', () => {
		let state = atAnte(FOUR, 2, withTeamPool(runInMode(FOUR, 'teams', TEAMS)))
		state = send(state, 'ann', blindResult('2:Small', true)).state
		state = send(state, 'bob', blindResult('2:Small', true)).state
		expect(runOf(state).teamLives).toEqual({ A: 3, B: 4 })
		expect(bonusesOf(state, 'ann')).toEqual([bonus(1)])
		expect(bonusesOf(state, 'bob')).toEqual([bonus(1)])
		expect(bonusesOf(state, 'cat')).toEqual([])
	})

	it('Teams: the pool at its last life still gives the item, and a pool at 0 nothing more', () => {
		const base = runInMode(FOUR, 'teams', TEAMS)
		let state = atAnte(FOUR, 2, {
			...base,
			run: { ...runOf(base), teamLives: { A: 1, B: 4 } },
		})
		state = send(state, 'ann', blindResult('2:Small', true)).state
		expect(runOf(state).teamLives).toEqual({ A: 0, B: 4 })
		expect(bonusesOf(state, 'ann')).toEqual([bonus(1)])
		state = send(state, 'bob', blindResult('2:Big', true)).state
		expect(bonusesOf(state, 'bob')).toEqual([bonus(1)])
	})
})

describe('the comeback bonus item, as laws', () => {
	const step = fc.record({
		player: fc.constantFrom(...DUEL),
		blindKey: fc.constantFrom('1:Small', '2:Small', '2:Big', '3:Small'),
		pvpBlindLost: fc.boolean(),
	})

	function play(
		steps: { player: string; blindKey: string; pvpBlindLost: boolean }[],
		twice: boolean,
	): State {
		let state = atAnte(DUEL, 3)
		for (const each of steps)
			for (let count = 0; count < (twice ? 2 : 1); count++)
				state = send(
					state,
					each.player,
					blindResult(each.blindKey, each.pvpBlindLost),
				).state
		return state
	}

	it('one item per life lost, numbered 1, 2, 3 without a gap, none for a player who lost nothing', () => {
		fc.assert(
			fc.property(fc.array(step, { maxLength: 14 }), (steps) => {
				const state = play(steps, false)
				for (const player of DUEL) {
					const lost = 4 - livesOf(state, player)
					const items = bonusesOf(state, player)
					expect(items).toHaveLength(lost)
					expect(items.map((item) => item.itemNumber)).toEqual(
						Array.from({ length: lost }, (_, index) => index + 1),
					)
					expect(
						runOf(state).lives[player].events.filter((e) => e.delta < 0),
					).toHaveLength(lost)
				}
			}),
		)
	})

	it('every input sent twice changes nothing: a resend never adds an item', () => {
		fc.assert(
			fc.property(fc.array(step, { maxLength: 10 }), (steps) => {
				expect(play(steps, true).run).toEqual(play(steps, false).run)
			}),
		)
	})

	it('comebackBonusOwners: nobody when the gold is off', () => {
		const lost = {
			lives: 3,
			status: 'playing' as const,
			events: [{ delta: -1, cause: null }],
		}
		const before = { a: { ...lost, lives: 4, events: [] } }
		expect(comebackBonusOwners(before, { a: lost }, 'none')).toEqual([])
		expect(comebackBonusOwners(before, { a: lost }, 'paid')).toEqual(['a'])
	})

	it('comebackBonusOwners: nobody for equal lives, one name per negative event added', () => {
		const seat = (deltas: number[]): PvpLifePlayer => ({
			lives: 4,
			status: 'playing',
			events: deltas.map((delta) => ({ delta, cause: null })),
		})
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(-1, 1), { maxLength: 6 }),
				fc.array(fc.constantFrom(-1, 1), { maxLength: 6 }),
				(earlier, added) => {
					const before = { a: seat(earlier) }
					expect(comebackBonusOwners(before, before, 'paid')).toEqual([])
					const after = { a: seat([...earlier, ...added]) }
					expect(comebackBonusOwners(before, after, 'paid')).toHaveLength(
						added.filter((delta) => delta < 0).length,
					)
				},
			),
		)
	})
})
