import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	endPlayerPause,
	isCounting,
	shiftTimes,
	startPlayerPause,
	timeLeft,
} from '../core/clock'
import type { PlayerId, State } from '../core/types'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import { LIMITS } from '../testing/state'
import {
	BASE,
	blindStart,
	countdownsOf,
	runOfMode,
	start,
	startedFor,
} from '../testing/timers'
import { runOutTimers } from './timer_run_out'

const frozenOf = (state: State) =>
	countdownsOf(state).filter((c) => c.hold.kind === 'paused for ready')

describe('a frozen Ante countdown goes back to what its starter is doing', () => {
	// ann is Ready and times bob, cat and dan.
	const nemesis = (): State =>
		start(
			ready(runOfMode(['ann', 'bob', 'cat', 'dan'], 'royale'), 'ann').state,
			'ann',
			'ante',
		).state

	it('in a game of two: the starter un-readies, bob gets Ready and un-readies, ann starts again', () => {
		const timing = start(
			ready(runOfMode(['ann', 'bob'], 'nemesis'), 'ann').state,
			'ann',
			'ante',
		).state
		const annOut = ready(timing, 'ann', false, BLIND, 10_000).state
		const frozen = ready(annOut, 'bob', true, BLIND, 30_000).state
		expect(startedFor(frozen, 'ann', 'ante')).toEqual([])
		expect(frozenOf(frozen)).toHaveLength(1)
		const thawed = ready(frozen, 'bob', false, BLIND, 70_000).state
		const bobs = startedFor(thawed, 'bob', 'ante')[0]
		expect(timeLeft(bobs, 70_000)).toBe(timeLeft(bobs, 100_000))
		const again = start(
			ready(thawed, 'ann', true, BLIND, 80_000).state,
			'ann',
			'ante',
			90_000,
		)
		expect(again.refusals).toEqual([])
		const running = startedFor(again.state, 'bob', 'ante')[0]
		expect(isCounting(running)).toBe(true)
		expect(timeLeft(running, 90_000)).toBe(BASE - 10_000)
	})

	it('the starter stops, then starts again, while the target is still Ready', () => {
		const frozen = ready(nemesis(), 'bob', true, BLIND, 30_000).state
		const stopped = send(frozen, 'ann', { kind: 'timerPause' }, 40_000).state
		expect(frozenOf(stopped)[0].hold).toMatchObject({
			kind: 'paused for ready',
			after: 'paused by starter',
		})
		const again = start(stopped, 'ann', 'ante', 50_000)
		expect(again.refusals).toEqual([])
		expect(frozenOf(again.state)[0].hold).toMatchObject({ after: 'counting' })
		const thawed = ready(again.state, 'bob', false, BLIND, 60_000).state
		const bobs = startedFor(thawed, 'bob', 'ante')[0]
		expect(isCounting(bobs)).toBe(true)
		expect(timeLeft(bobs, 60_000)).toBe(BASE - 30_000)
	})

	it('the starter stops and bob un-readies: he waits for the next start', () => {
		const frozen = ready(nemesis(), 'bob', true, BLIND, 30_000).state
		const stopped = send(frozen, 'ann', { kind: 'timerPause' }, 40_000).state
		const thawed = ready(stopped, 'bob', false, BLIND, 60_000).state
		expect(isCounting(startedFor(thawed, 'bob', 'ante')[0])).toBe(false)
	})

	it('two targets who got Ready at different times each keep their own time', () => {
		const both = ready(
			ready(nemesis(), 'bob', true, BLIND, 20_000).state,
			'cat',
			true,
			BLIND,
			50_000,
		).state
		expect(frozenOf(both)).toHaveLength(2)
		const bobBack = ready(both, 'bob', false, BLIND, 90_000).state
		const catBack = ready(bobBack, 'cat', false, BLIND, 100_000).state
		const bobs = startedFor(catBack, 'bob', 'ante')[0]
		const cats = startedFor(catBack, 'cat', 'ante')[0]
		expect(timeLeft(bobs, 90_000)).toBe(BASE - 20_000)
		expect(timeLeft(cats, 100_000)).toBe(BASE - 50_000)
	})

	it('the PvP blind start leaves no frozen countdown', () => {
		let state = ready(nemesis(), 'bob', true, BLIND, 30_000).state
		state = ready(state, 'cat', true, BLIND, 31_000).state
		state = ready(state, 'dan', true, BLIND, 32_000).state
		for (const player of ['ann', 'bob', 'cat', 'dan'])
			state = blindStart(state, player)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(frozenOf(state)).toEqual([])
	})

	it('moving time forward keeps a frozen countdown frozen with its return state', () => {
		const frozen = ready(nemesis(), 'bob', true, BLIND, 30_000).state
		const before = frozenOf(frozen)[0]
		const after = frozenOf(shiftTimes(frozen, 5000))[0]
		expect(after.hold).toEqual({
			kind: 'paused for ready',
			sinceAt: 35_000,
			after: 'counting',
		})
		expect(timeLeft(after, 99_000)).toBe(timeLeft(before, 99_000 - 5000))
	})
})

type Event =
	| { kind: 'ready'; player: number; value: boolean }
	| { kind: 'start'; player: number }
	| { kind: 'stop'; player: number }
	| { kind: 'away'; player: number }
	| { kind: 'back'; player: number }
	| { kind: 'wait'; milliseconds: number }

const events = (players: number): fc.Arbitrary<Event[]> => {
	const who = fc.nat({ max: players - 1 })
	return fc.array(
		fc.oneof(
			fc.record({
				kind: fc.constant('ready' as const),
				player: who,
				value: fc.boolean(),
			}),
			fc.record({ kind: fc.constant('start' as const), player: who }),
			fc.record({ kind: fc.constant('stop' as const), player: who }),
			fc.record({ kind: fc.constant('away' as const), player: who }),
			fc.record({ kind: fc.constant('back' as const), player: who }),
			fc.record({
				kind: fc.constant('wait' as const),
				milliseconds: fc.integer({ min: 1, max: 40_000 }),
			}),
		),
		{ maxLength: 40 },
	)
}

describe('model: Ready, timers and away in any order', () => {
	const run = (count: number, list: Event[]) => {
		const ids: PlayerId[] = ['ann', 'bob', 'cat', 'dan'].slice(0, count)
		let state = runOfMode(ids, count === 2 ? 'nemesis' : 'royale')
		const away = new Set<PlayerId>()
		let now = 0
		const checks: Array<{ state: State; now: number }> = []
		for (const event of list) {
			if (event.kind === 'wait') now += event.milliseconds
			else {
				const id = ids[event.player]
				if (event.kind === 'ready')
					state = ready(state, id, event.value, BLIND, now).state
				else if (event.kind === 'start')
					state = start(state, id, 'ante', now).state
				else if (event.kind === 'stop')
					state = send(state, id, { kind: 'timerPause' }, now).state
				else if (event.kind === 'away' && !away.has(id)) {
					away.add(id)
					state = {
						...state,
						run: {
							...runOf(state),
							clocks: startPlayerPause(
								runOf(state).clocks,
								id,
								'away',
								LIMITS,
								now,
							),
						},
					}
				} else if (event.kind === 'back' && away.has(id)) {
					away.delete(id)
					state = {
						...state,
						run: {
							...runOf(state),
							clocks: endPlayerPause(runOf(state).clocks, id, 'away', now),
						},
					}
				}
			}
			checks.push({ state, now })
		}
		return { checks, now, ids }
	}

	it.each([2, 3, 4])('invariants hold for %i players', (count) => {
		fc.assert(
			fc.property(events(count), (list) => {
				const { checks, now } = run(count, list)
				for (const { state, now: at } of checks) {
					const clocks = runOf(state).clocks
					for (const c of clocks.countdowns) {
						if (c.kind === 'ante') expect(c.against.length).toBeGreaterThan(0)
						if (c.hold.kind !== 'paused for ready') continue
						expect(c.kind).toBe('ante')
						expect(c.against).toHaveLength(1)
						expect(runOf(state).ready[c.against[0]]).toBeDefined()
						expect(timeLeft(c, at)).toBe(timeLeft(c, at + 1_000_000))
					}
					const frozen = frozenOf(state)
					const out = runOutTimers(state, at + 10 * BASE)
					for (const c of frozen)
						expect(runOf(out).lives[c.against[0]].lives).toBe(
							runOf(state).lives[c.against[0]].lives,
						)
				}
				expect(now).toBeGreaterThanOrEqual(0)
			}),
			{ numRuns: 150 },
		)
	})
})
