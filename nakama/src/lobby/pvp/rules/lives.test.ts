// The life ledger against literal states, with the real waiting-death rules.
import { describe, expect, it } from 'vitest'
import type { Run } from '../core/types'
import { runState } from '../testing/state'
import { duelMode } from '../modes/duel'
import type { Mode } from '../modes/types'
import {
	type PlayerAction,
	type PvpLifePlayer,
	applyAction,
	chargeLife,
	gainVoucherLives,
	handleTimerRunOut,
	markLeft,
} from './lives'
import { inRunIgnoringLives } from './players'

const playerWith = (overrides: Partial<PvpLifePlayer> = {}): PvpLifePlayer => ({
	lives: 2,
	status: 'playing',
	events: [],
	...overrides,
})

function game(
	overrides: {
		players?: { [id: string]: PvpLifePlayer }
		forgiveness?: number
	} = {},
): Run {
	const players = overrides.players ?? { a: playerWith(), b: playerWith() }
	const run = runState(Object.keys(players)).run
	if (run === null) throw new Error('no run')
	return {
		...run,
		rules: { ...run.rules, timerForgiveness: overrides.forgiveness ?? 0 },
		lives: players,
	}
}

const SOLO: Mode = duelMode

// A team pool in which every sharer shows the pool's value: a and b are one team.
const TEAM: Mode = {
	...duelMode,
	lifePool: {
		teamMemberIds: (run, id) =>
			id in run.lives && run.lives[id].lives > 0 ? ['a', 'b'] : [],
		takeLife: (run, id, cause) => {
			const lives = run.lives[id].lives - 1
			const players = { ...run.lives }
			for (const playerId of ['a', 'b'])
				players[playerId] = {
					...players[playerId],
					lives,
					status: lives <= 0 ? 'out' : 'playing',
					events: [...players[playerId].events, { delta: -1, cause }],
				}
			return { ...run, lives: players }
		},
		payers: () => [],
	},
}

const livesOf = (run: Run, id: string): number => run.lives[id].lives

describe('chargeLife (a player with their own lives)', () => {
	it('takes one life and records the event', () => {
		const out = chargeLife(game(), SOLO, 'a', { kind: 'blind', blindKey: '2:Boss' })
		expect(livesOf(out, 'a')).toBe(1)
		expect(out.lives.a.events).toEqual([{ delta: -1, cause: '2:Boss' }])
		expect(livesOf(out, 'b')).toBe(2)
	})

	it('spends a charged loss once per blind (R2)', () => {
		const once = chargeLife(game(), SOLO, 'a', { kind: 'blind', blindKey: '2:Boss' })
		const twice = chargeLife(once, SOLO, 'a', { kind: 'blind', blindKey: '2:Boss' })
		expect(livesOf(twice, 'a')).toBe(1)
		const other = chargeLife(once, SOLO, 'a', { kind: 'blind', blindKey: '3:Small' })
		expect(livesOf(other, 'a')).toBe(0)
	})

	it('an uncharged loss always costs and leaves the charge alone (R3)', () => {
		const once = chargeLife(game(), SOLO, 'a', { kind: 'timer_ran_out' })
		const twice = chargeLife(once, SOLO, 'a', { kind: 'timer_ran_out' })
		expect(livesOf(twice, 'a')).toBe(0)
		expect(twice.lifeLedger.lifeTakenFor).toEqual({})
	})

	it('two PvP losses on one blind cost two lives', () => {
		const first = chargeLife(game(), SOLO, 'a', { kind: 'pvp_blind', number: 1, blindKey: '2:Boss' })
		const second = chargeLife(first, SOLO, 'a', { kind: 'pvp_blind', number: 2, blindKey: '2:Boss' })
		expect(livesOf(second, 'a')).toBe(0)
	})

	it('a PvP loss after a failed blind loss on the same blind costs nothing more', () => {
		const failed = chargeLife(game(), SOLO, 'a', { kind: 'blind', blindKey: '2:Boss' })
		const pvp = chargeLife(failed, SOLO, 'a', { kind: 'pvp_blind', number: 1, blindKey: '2:Boss' })
		expect(livesOf(pvp, 'a')).toBe(1)
	})

	it('the last life eliminates the player and opens a death on the loss key', () => {
		const out = chargeLife(
			game({ players: { a: playerWith({ lives: 1 }), b: playerWith() } }),
			SOLO,
			'a',
			{ kind: 'blind', blindKey: '2:Small' },
		)
		expect(out.lives.a.status).toBe('out')
		expect(out.waitingDeaths).toEqual([
			{ playerId: 'a', blindKey: '2:Small', waitingFor: ['b'] },
		])
	})

	it.each<[string, Partial<PvpLifePlayer>]>([
		['out of lives', { lives: 0 }],
		['eliminated', { status: 'out' }],
		['forfeited', { status: 'forfeited' }],
		['left', { status: 'left' }],
	])('a player that is %s loses nothing', (_name, overrides) => {
		const state = game({ players: { a: playerWith(overrides) } })
		expect(chargeLife(state, SOLO, 'a', { kind: 'timer_ran_out' })).toBe(state)
	})

	it('an unknown player loses nothing', () => {
		const state = game()
		expect(chargeLife(state, SOLO, 'x', { kind: 'timer_ran_out' })).toBe(state)
	})
})

describe('chargeLife (a team pool, R47-R49)', () => {
	it('two teammates failing the same stretch cost the pool one life', () => {
		const first = chargeLife(game(), TEAM, 'a', { kind: 'blind', blindKey: '2:Small' })
		const second = chargeLife(first, TEAM, 'b', { kind: 'blind', blindKey: '2:Small' })
		expect(livesOf(second, 'a')).toBe(1)
		expect(livesOf(second, 'b')).toBe(1)
	})

	it('a member progressing resets the charge, so the next failure costs again', () => {
		const first = chargeLife(game(), TEAM, 'a', { kind: 'blind', blindKey: '2:Small' })
		const rearmed = applyAction(
			first,
			{ type: 'progress', playerId: 'b' },
			TEAM,
		)
		const again = chargeLife(rearmed, TEAM, 'b', { kind: 'blind', blindKey: '2:Big' })
		expect(livesOf(again, 'a')).toBe(0)
	})

	it('a failure on a PvP blind is the player’s own and charged on the blind', () => {
		const first = chargeLife(game(), TEAM, 'a', { kind: 'blind', blindKey: '2:Boss' })
		const again = chargeLife(first, TEAM, 'a', { kind: 'blind', blindKey: '2:Boss' })
		expect(livesOf(first, 'a')).toBe(1)
		expect(livesOf(again, 'a')).toBe(1)
		expect(first.lifeLedger.lifeTakenFor).toEqual({ a: ['2:Boss'] })
	})

	it('a lost PvP blind is charged on the whole team', () => {
		const lost = chargeLife(game(), TEAM, 'a', { kind: 'pvp_blind', number: 1, blindKey: '2:Boss' })
		expect(lost.lifeLedger.lifeTakenFor).toEqual({
			a: ['2:Boss'],
			b: ['2:Boss'],
		})
		const teammateFails = chargeLife(lost, TEAM, 'b', { kind: 'blind', blindKey: '2:Boss' })
		expect(livesOf(teammateFails, 'a')).toBe(1)
	})

	it('a pool at 0 costs nothing and the last life opens a death', () => {
		const out = chargeLife(
			game({
				players: { a: playerWith({ lives: 1 }), b: playerWith({ lives: 1 }) },
			}),
			TEAM,
			'a',
			{ kind: 'blind', blindKey: '2:Small' },
		)
		expect(out.waitingDeaths.map((death) => death.playerId)).toEqual(['a'])
		expect(chargeLife(out, TEAM, 'b', { kind: 'blind', blindKey: '3:Small' })).toBe(out)
	})
})

describe('handleTimerRunOut', () => {
	it('uses up a forgiven run-out, then costs a life with no key (R3)', () => {
		const state = game({
			forgiveness: 1,
			players: { a: playerWith({ lives: 1 }) },
		})
		const forgiven = handleTimerRunOut(state, SOLO, 'a')
		expect(livesOf(forgiven, 'a')).toBe(1)
		expect(forgiven.lifeLedger.runOutsForgiven).toEqual({ a: 1 })
		const lost = handleTimerRunOut(forgiven, SOLO, 'a')
		expect(livesOf(lost, 'a')).toBe(0)
		expect(lost.waitingDeaths).toEqual([])
	})
})

describe('applyAction', () => {
	const lost: PlayerAction = {
		type: 'blind',
		playerId: 'a',
		blindKey: '2:Small',
		result: 'lost',
	}
	const failedNotLost: PlayerAction = { ...lost, result: 'failed on the clock' }

	it('charges a lost PvP blind', () => {
		expect(livesOf(applyAction(game(), lost, SOLO), 'a')).toBe(1)
	})

	it('a failed blind that did not lose the PvP blind costs nothing', () => {
		const out = applyAction(game(), failedNotLost, SOLO)
		expect(livesOf(out, 'a')).toBe(2)
	})

	it('a forfeit flags the player', () => {
		const forfeit: PlayerAction = { type: 'forfeit', playerId: 'a' }
		const out = applyAction(applyAction(game(), forfeit, SOLO), forfeit, SOLO)
		expect(out.lives.a.status).toBe('forfeited')
	})

	it('a voucher gives each named gainer in the run a life, never a player at 0', () => {
		const mode: Mode = {
			...duelMode,
			voucherGainers: () => ['a', 'b', 'x'],
		}
		const state = game({
			players: { a: playerWith(), b: playerWith({ lives: 0 }) },
		})
		const out = gainVoucherLives(state, mode, {
			playerId: 'r',
			voucherKey: 'v_x',
		})
		expect(livesOf(out, 'a')).toBe(3)
		expect(out.lives.a.events).toEqual([{ delta: 1, cause: null }])
		expect(livesOf(out, 'b')).toBe(0)
	})

	it('two vouchers at one ante give each gainer +2, as two events (R42)', () => {
		const mode: Mode = {
			...duelMode,
			voucherGainers: () => ['a', 'b'],
		}
		const bought = (voucherKey: string): PlayerAction => ({
			type: 'voucher',
			playerId: 'r',
			voucherKey,
		})
		const out = applyAction(
			applyAction(game(), bought('v_one'), mode),
			bought('v_two'),
			mode,
		)
		for (const id of ['a', 'b']) {
			expect(livesOf(out, id)).toBe(4)
			expect(out.lives[id].events).toEqual([
				{ delta: 1, cause: null },
				{ delta: 1, cause: null },
			])
		}
	})

	it('a gain between two PvP losses on one Boss key: each PvP blind costs one, the failed blind nothing (R42)', () => {
		const mode: Mode = {
			...duelMode,
			voucherGainers: () => ['a'],
		}
		const bought = { playerId: 'r', voucherKey: 'v_one' }
		let state = game({ players: { a: playerWith({ lives: 3 }) } })
		state = chargeLife(state, mode, 'a', { kind: 'pvp_blind', number: 1, blindKey: '2:Boss' })
		state = gainVoucherLives(state, mode, bought)
		expect(livesOf(state, 'a')).toBe(3)
		state = chargeLife(state, mode, 'a', { kind: 'pvp_blind', number: 2, blindKey: '2:Boss' })
		expect(livesOf(state, 'a')).toBe(2)
		state = chargeLife(state, mode, 'a', { kind: 'blind', blindKey: '2:Boss' })
		expect(livesOf(state, 'a')).toBe(2)
		expect(state.lives.a.events).toEqual([
			{ delta: -1, cause: 'pvp:1' },
			{ delta: 1, cause: null },
			{ delta: -1, cause: 'pvp:2' },
		])
		const other = chargeLife(state, mode, 'a', { kind: 'blind', blindKey: '1:Small' })
		expect(livesOf(other, 'a')).toBe(1)
	})

	it('a voucher moves no life in a pooled game or a mode with no gainers', () => {
		const state = game()
		const action = { playerId: 'r', voucherKey: 'v_x' }
		expect(gainVoucherLives(state, SOLO, action)).toBe(state)
		const pooled = { ...TEAM, voucherGainers: () => ['a'] }
		expect(gainVoucherLives(state, pooled, action)).toBe(state)
	})
})

describe('markLeft and the predicates', () => {
	it('flags a player as left, once', () => {
		const state = game({
			players: { a: playerWith(), b: playerWith() },
		})
		const out = markLeft(state, 'b')
		expect(out.lives.b.status).toBe('left')
		expect(out.lives.a.status).toBe('playing')
		expect(markLeft(out, 'b')).toBe(out)
	})

	it('inRunIgnoringLives counts a player at 0 lives but not one that is out', () => {
		expect(inRunIgnoringLives(playerWith({ lives: 0 }))).toBe(true)
		expect(inRunIgnoringLives(playerWith({ status: 'out' }))).toBe(false)
		expect(inRunIgnoringLives(playerWith({ status: 'forfeited' }))).toBe(false)
		expect(inRunIgnoringLives(playerWith({ status: 'left' }))).toBe(false)
		expect(inRunIgnoringLives(undefined)).toBe(false)
	})
})
