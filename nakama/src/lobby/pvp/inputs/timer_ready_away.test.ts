import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { endPlayerPause, isCounting, startPlayerPause, timeLeft } from '../core/clock'
import type { PlayerId, State } from '../core/types'
import { type ShellFacts, shellTick } from '../match_hooks/pvp_shell'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import { LIMITS, droppedAt } from '../testing/state'
import {
	BASE,
	countdownsOf,
	inPvpBlind,
	runOfMode,
	scored,
	start,
	startedFor,
} from '../testing/timers'
import { timerButtonOf, timersView } from './timer'
import { runOutTimers } from './timer_run_out'

const awayState = (state: State, player: PlayerId, now: number): State => ({
	...state,
	run: {
		...runOf(state),
		clocks: startPlayerPause(runOf(state).clocks, player, 'away', LIMITS, now),
	},
})

const backState = (state: State, player: PlayerId, now: number): State => ({
	...state,
	run: {
		...runOf(state),
		clocks: endPlayerPause(runOf(state).clocks, player, 'away', now),
	},
})

describe('no timer starts while a player is away', () => {
	const waiting = (): State =>
		ready(runOfMode(['ann', 'bob'], 'nemesis'), 'ann').state

	it('an Ante press is refused and changes nothing; after they are back it works', () => {
		const away = awayState(waiting(), 'bob', 1000)
		const refused = start(away, 'ann', 'ante', 2000)
		expect(refused.refusals).toEqual(['someone_away'])
		expect(refused.state.run).toEqual(runOf(away))
		const back = backState(away, 'bob', 3000)
		expect(start(back, 'ann', 'ante', 4000).refusals).toEqual([])
		expect(startedFor(start(back, 'ann', 'ante', 4000).state, 'bob', 'ante')).toHaveLength(1)
	})

	it('a PvP press is refused and changes nothing; after they are back it works', () => {
		const scoring = scored(inPvpBlind(), 'ann', '5')
		const away = awayState(scoring, 'bob', 500)
		const refused = start(away, 'ann', 'pvp', 1000)
		expect(refused.refusals).toEqual(['someone_away'])
		expect(refused.state.run).toEqual(runOf(away))
		const back = backState(away, 'bob', 2000)
		expect(start(back, 'ann', 'pvp', 3000).refusals).toEqual([])
	})

	it('the view says the press is blocked, and offers it again once they are back', () => {
		const away = awayState(waiting(), 'bob', 1000)
		expect(timerButtonOf(away, 'ann', 2000)).toBe('someone away')
		expect(timersView(away, 'ann', 2000).timerButton).toBe('someone away')
		expect(timerButtonOf(backState(away, 'bob', 3000), 'ann', 4000)).toBe('ante')
	})

	it('there is no blocked button where no timer could start anyway', () => {
		const away = awayState(runOfMode(['ann', 'bob'], 'nemesis'), 'bob', 1000)
		expect(timerButtonOf(away, 'ann', 2000)).toBe('none')
	})

	it('the starter may still stop a timer it started while someone is away', () => {
		const started = start(waiting(), 'ann', 'ante', 0).state
		const away = awayState(started, 'bob', 1000)
		expect(send(away, 'ann', { kind: 'timerPause' }, 2000).refusals).toEqual([])
	})
})

describe('Ready freezes the time left under an Ante countdown', () => {
	// ann is Ready and times bob and cat at time 0 (they end at BASE).
	const timing = (): State =>
		start(
			ready(runOfMode(['ann', 'bob', 'cat'], 'royale'), 'ann').state,
			'ann',
			'ante',
		).state

	const bobsCountdown = (state: State) => startedFor(state, 'bob', 'ante')[0]

	it('shows the frozen time to the player while Ready, and goes on from it after', () => {
		const frozen = ready(timing(), 'bob', true, BLIND, 40_000).state
		expect(bobsCountdown(frozen).hold).toEqual({
			kind: 'paused for ready',
			sinceAt: 40_000,
			after: 'counting',
		})
		const own = timersView(frozen, 'bob', 90_000).deadlines.find(
			(deadline) => deadline.kind === 'ante',
		)
		expect(own?.hold).toBe('paused for ready')
		expect(own?.pausedAt).toBe(40_000)
		expect(own?.endsAt).toBe(BASE)

		const thawed = ready(frozen, 'bob', false, BLIND, 100_000).state
		const back = bobsCountdown(thawed)
		expect(back.hold).toEqual({ kind: 'counting' })
		expect(timeLeft(back, 100_000)).toBe(BASE - 40_000)
		expect(countdownsOf(thawed).some((c) => c.against.includes('cat'))).toBe(true)
	})

	it('leaves the countdown on the others running', () => {
		const frozen = ready(timing(), 'bob', true, BLIND, 40_000).state
		const cats = startedFor(frozen, 'cat', 'ante')
		expect(cats).toHaveLength(1)
		expect(cats[0].against).toEqual(['cat'])
		expect(cats[0].hold).toEqual({ kind: 'counting' })
		expect(cats[0].endsAt).toBe(BASE)
	})

	it('never charges a Ready player at the run-out, and keeps the frozen time', () => {
		const frozen = ready(timing(), 'bob', true, BLIND, 40_000).state
		const out = runOutTimers(frozen, BASE + 5000)
		expect(runOf(out).lives.bob.lives).toBe(runOf(frozen).lives.bob.lives)
		expect(timeLeft(bobsCountdown(out), BASE + 5000)).toBe(BASE - 40_000)
	})

	it('waits for the starter when the starter had stopped the timer meanwhile', () => {
		const frozen = ready(timing(), 'bob', true, BLIND, 40_000).state
		const stopped = send(frozen, 'ann', { kind: 'timerPause' }, 60_000).state
		const thawed = ready(stopped, 'bob', false, BLIND, 100_000).state
		expect(isCounting(bobsCountdown(thawed))).toBe(false)
		const again = start(thawed, 'ann', 'ante', 120_000).state
		expect(isCounting(bobsCountdown(again))).toBe(true)
		expect(timeLeft(bobsCountdown(again), 120_000)).toBe(BASE - 40_000)
	})

	it('a Ready player who is away and comes back is thawed with the Ready mark dropped', () => {
		const facts = (away: PlayerId[]): ShellFacts => ({
			gameStarted: true,
			away,
			left: [],
			grace: null,
			messageNumbers: {},
			ranked: true,
			forfeited: [],
			awayFrom: droppedAt(away),
		})
		const frozen = ready(timing(), 'bob', true, BLIND, 1000).state
		const away = shellTick(frozen, 2000, facts(['bob']))
		expect(bobsCountdown(away).hold.kind).toBe('paused for ready')
		const back = shellTick(away, 5000, facts([]))
		expect(runOf(back).ready.bob).toBeUndefined()
		expect(isCounting(bobsCountdown(back))).toBe(true)
		expect(timeLeft(bobsCountdown(back), 5000)).toBe(BASE - 1000)
	})

	it('property: whenever a timed player readies and un-readies, they have what they had', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: BASE - 1 }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(readiedAt, stay) => {
					const frozen = ready(timing(), 'bob', true, BLIND, readiedAt).state
					const thawed = ready(frozen, 'bob', false, BLIND, readiedAt + stay).state
					return (
						timeLeft(bobsCountdown(thawed), readiedAt + stay) === BASE - readiedAt
					)
				},
			),
		)
	})
})
