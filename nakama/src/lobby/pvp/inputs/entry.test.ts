import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { endPlayerPause, startPlayerPause } from '../core/clock'
import type { State } from '../core/types'
import { isAway } from '../rules/pvp_blind_rules'
import type { PvpMode } from '../rules/settings'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import { LIMITS, reported, runState } from '../testing/state'
import { openPvpBlindIfReady, pvpBlindView } from './pvp_blind'

const PLAYERS = ['ann', 'bob']
const start = (): State => reported(runState(PLAYERS))
const onAnte2 = (state: State): State =>
	PLAYERS.reduce(
		(next, player) =>
			send(next, player, { kind: 'progress', ante: 2, location: 'shop' }).state,
		state,
	)

const pvpBlindOf = (state: State) => {
	const currentPvpBlind = state.run?.currentPvpBlind
	if (currentPvpBlind === null || currentPvpBlind === undefined)
		throw new Error('no PvP blind')
	return currentPvpBlind
}

describe('ready', () => {
	it('a first ready is a mark on the run: no PvP blind is stored while it waits', () => {
		const { state, refusals } = ready(start(), 'ann')
		expect(refusals).toEqual([])
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect(runOf(state).ready).toEqual({ ann: BLIND })
		expect(pvpBlindView(onAnte2(state), 'bob')).toEqual({
			stage: 'waiting',
			blindKey: BLIND,
			players: { ann: 'ready', bob: 'not ready' },
		})
	})

	it('unready_before_opponent_ready_keeps_waiting', () => {
		let state = ready(start(), 'ann').state
		state = ready(state, 'ann', false).state
		state = ready(state, 'bob').state
		expect(runOf(state).currentPvpBlind).toBeNull()
	})

	it('opens the PvP blind inside the ready that completes it, with no tick', () => {
		const state = ready(ready(start(), 'ann').state, 'bob').state
		expect(pvpBlindOf(state).blindKey).toBe(BLIND)
	})

	it('unready_after_pvp_blind_opened_is_refused: the PvP blind keeps its players', () => {
		const opened = ready(ready(start(), 'ann').state, 'bob').state
		const { state, refusals } = ready(opened, 'ann', false)
		expect(refusals).toEqual(['pvp_blind_playing'])
		expect(pvpBlindOf(state)).toEqual(pvpBlindOf(opened))
	})

	it('ready_survives_away: an away player who is Ready still counts and the PvP blind opens', () => {
		let state = ready(start(), 'ann').state
		const clocks = startPlayerPause(
			runOf(state).clocks,
			'ann',
			'away',
			LIMITS,
			5,
		)
		state = { ...state, run: { ...runOf(state), clocks } }
		state = ready(state, 'bob', true, BLIND, 6).state
		expect(pvpBlindOf(state).blindKey).toBe(BLIND)
		expect(Object.keys(pvpBlindOf(state).players)).toEqual(['ann', 'bob'])
		expect(isAway(runOf(state), 'ann')).toBe(true)
		const back = endPlayerPause(runOf(state).clocks, 'ann', 'away', 7)
		expect(isAway({ ...runOf(state), clocks: back }, 'ann')).toBe(false)
	})

	it('starts no countdown of its own when the PvP blind opens', () => {
		const state = ready(
			ready(start(), 'ann', true, BLIND, 10).state,
			'bob',
			true,
			BLIND,
			20,
		).state
		expect(runOf(state).clocks.countdowns).toEqual([])
	})

	it('does not open a PvP blind with fewer than two players in', () => {
		const state = start()
		const lone = {
			...state,
			run: {
				...runOf(state),
				lives: {
					...runOf(state).lives,
					bob: { ...runOf(state).lives.bob, status: 'left' as const },
				},
			},
		}
		const pressed = ready(lone, 'ann')
		expect(pressed.refusals).toEqual(['not_in_pvp_blind'])
		expect(pressed.state.run?.currentPvpBlind).toBeNull()
		expect(pressed.state.run?.ready).toEqual({})
	})

	it.each([
		['not_pvp_blind', '1:Boss'],
		['not_pvp_blind', '2:Small'],
		['not_pvp_blind', 'Boss'],
	])('refuses %s for %s', (code, blindKey) => {
		const before = start()
		const { state, refusals, lastNumber } = send(before, 'ann', {
			kind: 'ready',
			ready: true,
			blindKey,
		})
		expect(refusals).toEqual([code])
		expect(state.run).toEqual(before.run)
		expect(lastNumber).toBe(1)
	})

	it('refuses a player who is out of the run', () => {
		const state = start()
		const out = {
			...state,
			run: {
				...runOf(state),
				lives: {
					...runOf(state).lives,
					ann: { ...runOf(state).lives.ann, status: 'out' as const },
				},
			},
		}
		expect(ready(out, 'ann').refusals).toEqual(['eliminated'])
	})

	it('refuses a blind that already has a PvP blind, and a blind while another is open', () => {
		const state = start()
		const done = {
			...state,
			run: {
				...runOf(state),
				finishedPvpBlinds: [
					{
						blindKey: BLIND,
						scores: {},
						endedBy: {},
						losers: [],
						close: 'played out' as const,
						livesAfter: {},
						teamScores: null,
					},
				],
			},
		}
		expect(ready(done, 'ann').refusals).toEqual(['pvp_blind_over'])
		const open = ready(ready(state, 'ann').state, 'bob').state
		expect(ready(open, 'bob', true, '3:Boss').refusals).toEqual(['wrong_blind'])
	})

	it('refuses a body that is not a ready', () => {
		const { refusals } = send(start(), 'ann', {
			kind: 'ready',
			ready: 'yes',
			blindKey: BLIND,
		})
		expect(refusals).toEqual(['bad_request_body'])
	})

	it('one_pvp_blind_per_blind_key', () => {
		const used = { ...start() }
		const withPvpBlind = {
			...used,
			run: {
				...runOf(used),
				finishedPvpBlinds: [
					{
						blindKey: BLIND,
						scores: {},
						endedBy: {},
						losers: [],
						close: 'played out' as const,
						livesAfter: {},
						teamScores: null,
					},
				],
			},
		}
		const step = fc.record({
			player: fc.constantFrom(...PLAYERS),
			value: fc.boolean(),
			blindKey: fc.constantFrom(BLIND, '3:Boss', '2:Small'),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
				let state: State = withPvpBlind
				for (const { player, value, blindKey } of steps)
					state = ready(state, player, value, blindKey).state
				const open = state.run?.currentPvpBlind
				expect(open === null || open?.blindKey !== BLIND).toBe(true)
			}),
		)
	})

	it('opens exactly when both were Ready together, and stays open', () => {
		const step = fc.record({
			player: fc.constantFrom(...PLAYERS),
			value: fc.boolean(),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 14 }), (steps) => {
				let state = start()
				const flags: { [player: string]: boolean } = { ann: false, bob: false }
				let expected = false
				for (const { player, value } of steps) {
					state = ready(state, player, value).state
					if (!expected) {
						flags[player] = value
						expected = flags.ann && flags.bob
					}
					const currentPvpBlind = state.run?.currentPvpBlind
					expect(currentPvpBlind !== null).toBe(expected)
				}
			}),
		)
	})
})

describe('team', () => {
	const noRun = (lobbyMode: PvpMode): State => ({
		lobbyMode,
		players: { ann: { team: null } },
		run: null,
		result: null,
	})
	const pick = (lobbyMode: PvpMode, team: string) =>
		send(noRun(lobbyMode), 'ann', { kind: 'team', team })

	it('takes the newest pick before the run', () => {
		let state = pick('teams', 'A').state
		expect(state.players.ann.team).toBe('A')
		state = send(state, 'ann', { kind: 'team', team: 'B' }).state
		expect(state.players.ann.team).toBe('B')
	})

	it.each([
		['teams', 'A', true],
		['teams', 'B', true],
		['teams', 'RUNNER', false],
		['teams', 'HUNTER', false],
		['manhunt', 'RUNNER', true],
		['manhunt', 'HUNTER', true],
		['manhunt', 'A', false],
		['manhunt', 'B', false],
		['royale', 'A', false],
		['royale', 'RUNNER', false],
		['nemesis', 'B', false],
		['nemesis', 'HUNTER', false],
	] as const)('in %s, picking %s is taken: %s', (mode, team, taken) => {
		const { state, refusals, lastNumber } = pick(mode, team)
		expect(refusals).toEqual(taken ? [] : ['team_not_offered'])
		expect(state.players.ann.team).toBe(taken ? team : null)
		expect(lastNumber).toBe(1)
	})

	it('refuses a pick once the run has started, and a team that does not exist', () => {
		const running = send(start(), 'ann', { kind: 'team', team: 'A' })
		expect(running.refusals).toEqual(['run_started'])
		expect(running.state.players.ann.team).toBeNull()
		expect(pick('teams', 'C').refusals).toEqual(['bad_request_body'])
	})
})
