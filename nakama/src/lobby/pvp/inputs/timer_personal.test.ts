import { describe, expect, it } from 'vitest'
import type { Countdown, State } from '../core/types'
import type { ClockRules } from '../rules/settings'
import { ready, runOf, send } from '../testing/inputs'
import {
	BASE,
	blindStart,
	configured,
	countdownsOf,
	livesOf,
	runOfMode,
	scored,
	start,
	timersViewAtSettle,
} from '../testing/timers'
import { timersView } from './timer'
import { runOutTimers } from './timer_run_out'

const PRESSURE: ClockRules = {
	ante: 'personal',
	pvp: null,
	personal: {
		kind: 'pressure',
		baseMilliseconds: 100_000,
		timedRate: 2,
		previewCostMilliseconds: 3500,
	},
}
const SPEEDLATRO: ClockRules = {
	ante: 'personal',
	pvp: null,
	personal: {
		kind: 'speedlatro',
		baseMilliseconds: 147_000,
		pvpMilliseconds: 73_500,
		timedRate: 2,
		previewCostMilliseconds: 0,
	},
}

const personalOf = (state: State, player: string): Countdown | undefined =>
	countdownsOf(state).find(
		(countdown) =>
			countdown.kind === 'personal' && countdown.against.includes(player),
	)

const climbed = (state: State, player: string, ante: number, now: number) =>
	send(state, player, { kind: 'progress', ante, location: 'shop' }, now).state

// Both players at ante 3 under the pressure clock.
const pressure = (): State => {
	let state = runOfMode(['ann', 'bob'], 'nemesis', { clocks: PRESSURE })
	for (const player of ['ann', 'bob']) state = climbed(state, player, 3, 0)
	return state
}

// Every player reaches ante 2 under the Speedlatro clock.
const speed = (
	players = ['ann', 'bob'],
	mode: 'nemesis' | 'royale' = 'nemesis',
): State => {
	const base = runOfMode(players, mode, { clocks: SPEEDLATRO })
	const fresh: State = {
		...base,
		run: {
			...runOf(base),
			players: Object.fromEntries(
				players.map((id) => [id, { ...runOf(base).players[id], ante: null }]),
			),
		},
	}
	return players.reduce((state, id) => climbed(state, id, 2, 0), fresh)
}

// ann and bob Ready and start the PvP blind.
const entered = (state: State): State => {
	let next = state
	for (const player of ['ann', 'bob']) next = ready(next, player).state
	for (const player of ['ann', 'bob']) next = blindStart(next, player)
	return next
}

const without = (state: State, player: string): State => ({
	...state,
	run: {
		...runOf(state),
		clocks: {
			...runOf(state).clocks,
			countdowns: countdownsOf(state).filter(
				(c) => !(c.kind === 'personal' && c.against.includes(player)),
			),
		},
	},
})

describe('the pressure clock', () => {
	it('an un-ready from a player who is not Ready leaves the clocks alone', () => {
		const state = climbed(pressure(), 'ann', 4, 5000)
		expect(personalOf(state, 'ann')?.hold.kind).toBe('counting')
		const after = ready(state, 'ann', false, '4:Boss', 6000)
		expect(after.refusals).toEqual([])
		expect(after.state.run).toEqual(state.run)
	})

	it('starts a personal countdown of base x multiplier at each ante', () => {
		const state = climbed(pressure(), 'ann', 4, 5000)
		const own = personalOf(state, 'ann')
		expect(own?.endsAt).toBe(105_000)
		expect(own?.kind === 'personal' ? own.rate : null).toBe(1)
	})

	it('runs at rate 2 while an Ante countdown times the player, and says so in the view', () => {
		const waiting = ready(pressure(), 'ann', true, '3:Boss', 10_000).state
		const timed = start(waiting, 'ann', 'ante', 10_000).state
		const bob = personalOf(timed, 'bob')
		expect(bob?.endsAt).toBe(55_000)
		const shown = timersViewAtSettle(timed, 'bob').deadlines.find(
			(deadline) => deadline.kind === 'personal',
		)
		expect(shown?.rate).toBe(2)
	})

	it('a run-out costs a life, restarts nothing and leaves no countdown', () => {
		const out = runOutTimers(pressure(), 100_001)
		expect(livesOf(out, 'ann')).toBe(3)
		expect(personalOf(out, 'ann')).toBeUndefined()
		expect(countdownsOf(out)).toEqual([])
	})

	it('a timed Pressure clock that runs out costs a life and starts again, still timed', () => {
		const timedState = start(
			ready(pressure(), 'ann', true, '3:Boss').state,
			'ann',
			'ante',
			0,
		).state
		const out = runOutTimers(timedState, 100_002)
		expect(livesOf(out, 'bob')).toBe(3)
		const bob = personalOf(out, 'bob')
		expect(bob?.endsAt).toBeGreaterThan(100_002)
		expect(bob?.kind === 'personal' ? bob.rate : null).toBe(2)
		expect(
			countdownsOf(out).some(
				(c) => c.kind === 'ante' && c.against.includes('bob'),
			),
		).toBe(true)
	})

	it('under the personal clock the pressed Ante countdown is a marker that never runs out', () => {
		const waiting = ready(pressure(), 'ann', true, '3:Boss', 0).state
		const timed = start(waiting, 'ann', 'ante', 0).state
		const out = runOutTimers(timed, 1_000_000)
		expect(countdownsOf(out).filter((c) => c.kind === 'ante')).toHaveLength(1)
	})

	it('the marker under the personal clock never runs out, for a player with no personal countdown either', () => {
		const timedState = start(
			ready(without(pressure(), 'bob'), 'ann', true, '3:Boss').state,
			'ann',
			'ante',
			0,
		).state
		const out = runOutTimers(timedState, 1_000_000)
		expect(countdownsOf(out).some((c) => c.kind === 'ante')).toBe(true)
		expect(livesOf(out, 'bob')).toBe(4)
	})
})

describe('the Speedlatro clock', () => {
	it('sets the blind clock with its wait and counts only while the opponent leads', () => {
		const level = entered(speed())
		const own = personalOf(level, 'ann')
		expect(own?.hold.kind).toBe('paused until timed')
		expect(
			own === undefined || own.hold.kind === 'counting'
				? null
				: own.endsAt - own.hold.sinceAt,
		).toBe(73_500)
		const behind = scored(level, 'bob', '5', 3, 1000)
		expect(personalOf(behind, 'ann')?.hold.kind).toBe('counting')
		expect(personalOf(behind, 'bob')?.hold.kind).not.toBe('counting')
	})

	it('after the PvP blind the clock is back to the full base', () => {
		const over = scored(
			scored(entered(speed()), 'bob', '5', 0, 1000),
			'ann',
			'3',
			0,
			2000,
		)
		expect(runOf(over).currentPvpBlind).toBeNull()
		expect(personalOf(over, 'ann')?.endsAt).toBe(2000 + 147_000)
	})

	it('a player without a clock gets one at the PvP length when the PvP blind starts', () => {
		const state = entered(without(speed(), 'ann'))
		const own = personalOf(state, 'ann')
		expect(own?.hold.kind).toBe('paused for pvp blind')
	})

	it('un-ready starts the Speedlatro clock again', () => {
		const readied = ready(speed(), 'ann', true, '2:Boss', 1000).state
		expect(personalOf(readied, 'ann')?.hold.kind).not.toBe('counting')
		const back = ready(readied, 'ann', false, '2:Boss', 2000).state
		expect(personalOf(back, 'ann')?.hold.kind).toBe('counting')
	})

	it('a done player who is behind keeps a stopped clock while others still play', () => {
		const players = ['ann', 'bob', 'cara']
		let state = speed(players, 'royale')
		for (const player of players) state = ready(state, player).state
		for (const player of players) state = blindStart(state, player)
		state = scored(state, 'bob', '5', 3, 1000)
		state = scored(state, 'cara', '5', 3, 1100)
		state = scored(state, 'ann', '3', 3, 1500)
		expect(personalOf(state, 'ann')?.hold.kind).toBe('counting')
		state = scored(state, 'ann', '3', 0, 2000)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(personalOf(state, 'ann')?.hold.kind).not.toBe('counting')
	})

	it('a Speedlatro run-out has no forgiveness', () => {
		const state = configured(speed(), { timerForgiveness: 1 })
		const out = runOutTimers(state, 147_001)
		expect(livesOf(out, 'ann')).toBe(3)
	})
})

describe('skip time', () => {
	const timed = (rule: 'lead' | 'own'): State =>
		configured(runOfMode(['ann', 'bob'], 'nemesis'), {
			timerIncrementMilliseconds: 5000,
			skipTimeRule: rule,
		})
	const skipped = (state: State, player: string, total: number, key: string) =>
		send(state, player, { kind: 'skip', blindKey: key, total }).state

	it.each<[string, 'lead' | 'own', number, number, number, number]>([
		['no skips', 'lead', 0, 0, BASE, BASE],
		['ann leads by two', 'lead', 2, 0, BASE + 10_000, BASE],
		['level skips cancel', 'lead', 2, 2, BASE, BASE],
		[
			'own rule counts every own skip',
			'own',
			2,
			2,
			BASE + 10_000,
			BASE + 10_000,
		],
	])('%s', (_name, rule, annSkips, bobSkips, annBank, bobBank) => {
		let state = timed(rule)
		for (let skip = 1; skip <= annSkips; skip++)
			state = skipped(state, 'ann', skip, skip === 1 ? '2:Small' : '2:Big')
		for (let skip = 1; skip <= bobSkips; skip++)
			state = skipped(state, 'bob', skip, skip === 1 ? '2:Small' : '2:Big')
		expect(timersViewAtSettle(state, 'ann').anteBanks).toEqual({
			ann: annBank,
			bob: bobBank,
		})
	})

	it('an Ante countdown starts from the starter bank, as on main', () => {
		let state = timed('lead')
		state = skipped(state, 'ann', 1, '2:Small')
		const waiting = ready(state, 'ann').state
		const started = start(waiting, 'ann', 'ante', 0).state
		expect(countdownsOf(started)[0].endsAt).toBe(BASE + 5000)
		const other = start(
			ready(skipped(timed('lead'), 'bob', 1, '2:Small'), 'ann').state,
			'ann',
			'ante',
			0,
		).state
		expect(countdownsOf(other)[0].endsAt).toBe(BASE)
	})

	it('under pressure an opponent skip adds the increment to my personal countdown', () => {
		let state = configured(pressure(), {
			timerIncrementMilliseconds: 5000,
			clocks: PRESSURE,
		})
		state = send(state, 'ann', {
			kind: 'skip',
			blindKey: '3:Small',
			total: 1,
		}).state
		expect(personalOf(state, 'bob')?.endsAt).toBe(105_000)
		expect(personalOf(state, 'ann')?.endsAt).toBe(100_000)
	})
})

describe('the display threshold', () => {
	it('hides a started Ante countdown from the timed player until its time left is at or below the threshold', () => {
		const base = configured(runOfMode(['ann', 'bob'], 'nemesis'), {
			timerDisplayThresholdMilliseconds: 100_000,
		})
		const started = start(ready(base, 'ann').state, 'ann', 'ante', 0).state
		const seen = (viewer: string, at: number): number =>
			timersView(started, viewer, at).deadlines.length
		expect(seen('bob', 0)).toBe(0)
		expect(seen('ann', 0)).toBe(1)
		expect(seen('bob', BASE - 100_000)).toBe(1)
	})
})
