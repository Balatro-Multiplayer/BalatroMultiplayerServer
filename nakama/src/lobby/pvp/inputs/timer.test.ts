import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { startCountdown, startPlayerPause } from '../core/clock'
import type { State } from '../core/types'
import { BLIND, endedByOf, ready, runOf, send } from '../testing/inputs'
import { LIMITS, pairedRun } from '../testing/state'
import {
	BASE,
	PVP,
	anteStarted,
	blindStart,
	configured,
	countdownsOf,
	inPvpBlind,
	played,
	pvpStarted,
	runOfMode,
	scored,
	start,
	startedFor,
	threeInPvpBlind,
	timerButtonOfAtSettle,
	timersViewAtSettle,
} from '../testing/timers'
import { timerButtonOf, paidPreviewsHandler, timersView } from './timer'
import {
	dropUnneededTimers,
	playersWhoLostALife,
	runOutTimers,
} from './timer_run_out'

const canStartTimer = (state: State, player: string): boolean =>
	timerButtonOfAtSettle(state, player) !== 'none'

const PRESSURE = {
	kind: 'pressure',
	baseMilliseconds: 100_000,
	timedRate: 1,
	previewCostMilliseconds: 20_000,
} as const

const refusalsOf = (state: State, player: string, timer: 'ante' | 'pvp') =>
	start(state, player, timer, 2000).refusals

describe('timerStart', () => {
	it('starts a PvP timer on the opponent for the PvP base time', () => {
		expect(countdownsOf(pvpStarted())).toEqual([
			{
				kind: 'pvp',
				by: 'ann',
				against: ['bob'],
				endsAt: 1000 + PVP.baseMilliseconds,
				hold: { kind: 'counting' },
			},
		])
	})

	it('starts an Ante timer on the players who are not Ready, for the base time', () => {
		expect(countdownsOf(anteStarted())).toMatchObject([
			{ kind: 'ante', by: 'ann', against: ['bob'], endsAt: BASE },
		])
	})

	it('with three players paired, the PvP timer runs against the partner only', () => {
		let state = threeInPvpBlind()
		state = scored(state, 'ann', '5')
		state = start(state, 'ann', 'pvp', 1000).state
		expect(countdownsOf(state)).toMatchObject([
			{ kind: 'pvp', by: 'ann', against: ['bob'] },
		])
	})

	it.each([
		[
			'the PvP timer is off',
			() => {
				const state = ready(runOfMode(['ann', 'bob'], 'nemesis'), 'ann').state
				return ready(state, 'bob').state
			},
			'pvp',
			'pvp_timer_off',
		],
		[
			'the PvP blind is only waiting',
			() =>
				ready(runOfMode(['ann', 'bob'], 'nemesis', { pvpTimer: true }), 'ann')
					.state,
			'pvp',
			'not_pvp_blind',
		],
		[
			'the sender has not sent a blind start',
			() => {
				let state = runOfMode(['ann', 'bob'], 'nemesis', { pvpTimer: true })
				state = ready(ready(state, 'ann').state, 'bob').state
				return blindStart(state, 'bob')
			},
			'pvp',
			'not_in_pvp_blind',
		],
		[
			'the opponent has not sent a blind start',
			() => {
				let state = runOfMode(['ann', 'bob'], 'nemesis', { pvpTimer: true })
				state = ready(ready(state, 'ann').state, 'bob').state
				return blindStart(state, 'ann')
			},
			'pvp',
			'nobody_to_time',
		],
		[
			'the starter is behind',
			() => scored(scored(inPvpBlind(), 'ann', '5'), 'bob', '9'),
			'pvp',
			'not_ahead',
		],
		[
			'the sender is not Ready',
			() => runOfMode(['ann', 'bob'], 'nemesis'),
			'ante',
			'not_ready',
		],
		[
			'nobody is left to time',
			() => {
				const state = runOfMode(['ann', 'bob'], 'nemesis')
				return ready(ready(state, 'bob').state, 'ann').state
			},
			'ante',
			'not_waiting',
		],
	] as const)('is refused when %s', (_name, build, timer, code) => {
		const before = build()
		const result = start(before, 'ann', timer)
		expect(result.refusals).toEqual([code])
		expect(result.state.run).toEqual(before.run)
	})

	it('is refused for a sender who is not Ready; a team mate is timed like any other player', () => {
		const waiting = ready(runOfMode(['ann', 'bob'], 'nemesis'), 'bob').state
		const notReady = send(waiting, 'ann', { kind: 'timerStart', timer: 'ante' })
		expect(notReady.refusals).toEqual(['not_ready'])
		const base = runOfMode(['ann', 'bob'], 'nemesis')
		const mates: State = {
			...base,
			players: {
				ann: { ...base.players.ann, team: 'A' },
				bob: { ...base.players.bob, team: 'A' },
			},
		}
		const started = start(ready(mates, 'ann').state, 'ann', 'ante')
		expect(started.refusals).toEqual([])
		expect(runOf(started.state).clocks.countdowns[0].against).toEqual(['bob'])
	})

	it('is refused for a player who is out of the run, and without a run', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const out: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, status: 'forfeited' } },
			},
		}
		expect(refusalsOf(out, 'ann', 'pvp')).toEqual(['eliminated'])
		expect(canStartTimer(out, 'ann')).toBe(false)
		const none: State = { ...state, run: null }
		expect(canStartTimer(none, 'ann')).toBe(false)
	})

	describe('the PvP timer asks who is ahead', () => {
		const level = (first: string, second: string): State =>
			scored(scored(inPvpBlind(), first, '7'), second, '7')

		it('ahead: may start', () => {
			expect(canStartTimer(scored(inPvpBlind(), 'ann', '5'), 'ann')).toBe(true)
			expect(canStartTimer(scored(inPvpBlind(), 'ann', '5'), 'bob')).toBe(false)
		})

		it('a score sent again does not move the order', () => {
			const again = scored(level('ann', 'bob'), 'ann', '7', 2)
			expect(canStartTimer(again, 'ann')).toBe(true)
			expect(canStartTimer(again, 'bob')).toBe(false)
		})

		it('a player who finished may still start, a target who finished may not be timed', () => {
			const finished = scored(
				scored(inPvpBlind(), 'ann', '9', 0),
				'bob',
				'1',
				3,
			)
			expect(endedByOf(finished, 'ann')).toBe('hands')
			expect(canStartTimer(finished, 'ann')).toBe(true)
			const targetDone = scored(scored(inPvpBlind(), 'ann', '5'), 'bob', '9', 0)
			expect(endedByOf(targetDone, 'bob')).toBe('hands')
			expect(refusalsOf(targetDone, 'ann', 'pvp')).toEqual(['nobody_to_time'])
		})

		it('a player ahead can always start, one behind never, unless level and first', () => {
			fc.assert(
				fc.property(fc.nat({ max: 50 }), fc.nat({ max: 50 }), (left, right) => {
					let state = inPvpBlind()
					state = scored(state, 'ann', String(left))
					state = scored(state, 'bob', String(right))
					expect(canStartTimer(state, 'ann')).toBe(left >= right)
					expect(canStartTimer(state, 'bob')).toBe(right > left)
				}),
			)
		})
	})

	it('first press wins: a second start on the same player changes nothing', () => {
		const state = anteStarted()
		const again = start(state, 'ann', 'ante', 5)
		expect(again.refusals).toEqual(['already_running'])
		expect(again.state.run).toEqual(state.run)
	})

	it('two starters cannot time the same player the same way', () => {
		let state = runOfMode(['ann', 'bob', 'cat'], 'royale')
		state = ready(ready(state, 'ann').state, 'bob').state
		state = start(state, 'ann', 'ante').state
		expect(start(state, 'bob', 'ante').refusals).toEqual(['already_timed'])
	})

	it('a timer the starter paused does not shield its targets from a new one', () => {
		let state = runOfMode(['ann', 'bob', 'cat'], 'royale')
		state = ready(state, 'ann').state
		state = start(state, 'ann', 'ante').state
		expect(startedFor(state, 'cat', 'ante')).toHaveLength(1)
		state = send(state, 'ann', { kind: 'timerPause' }, 1000).state
		state = ready(state, 'cat').state
		const result = start(state, 'cat', 'ante', 2000)
		expect(result.refusals).toEqual([])
		expect(startedFor(result.state, 'bob', 'ante')).toHaveLength(2)
	})

	it('a timer still counting shields its targets: they are timed once', () => {
		let state = runOfMode(['ann', 'bob', 'cat'], 'royale')
		state = ready(ready(state, 'ann').state, 'cat').state
		state = start(state, 'ann', 'ante').state
		expect(start(state, 'cat', 'ante', 2000).refusals).toEqual([
			'already_timed',
		])
	})

	it('the starter of a timer held because its target animates cannot start it again', () => {
		const held = send(
			pvpStarted(),
			'bob',
			{ kind: 'animating', on: true },
			2000,
		).state
		expect(countdownsOf(held)[0].hold.kind).toBe('held for player')
		const again = start(held, 'ann', 'pvp', 3000)
		expect(again.refusals).toEqual(['already_running'])
		expect(again.state.run).toEqual(runOf(held))
	})

	it('a player with no seat on the clocks cannot be paused for animating', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const { cat: _gone, ...players } = run.clocks.players
		const noClock: State = {
			...state,
			players: { ...state.players, cat: state.players.bob },
			run: {
				...run,
				players: { ...run.players, cat: run.players.bob },
				clocks: { ...run.clocks, players },
			},
		}
		const result = send(noClock, 'cat', { kind: 'animating', on: true })
		expect(result.refusals).toEqual(['unknown_player'])
		expect(result.state.run).toEqual(noClock.run)
	})

	it.each([
		[
			'a timer kind that does not exist',
			{ kind: 'timerStart', timer: 'nothing' },
		],
		['no timer kind', { kind: 'timerStart' }],
		[
			'a field that does not exist',
			{ kind: 'timerStart', timer: 'ante', extra: 1 },
		],
		['a total that is negative', { kind: 'paidPreviews', total: -1 }],
		['an animating flag that is not a flag', { kind: 'animating', on: 'yes' }],
	])('refuses %s as a bad body', (_name, body) => {
		const before = anteStarted()
		const result = send(before, 'ann', body)
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(result.state.run).toEqual(before.run)
	})

	it('timer_start_refused_while_timered', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('ante', 'pvp'),
				fc.constantFrom('ante', 'pvp'),
				fc.integer({ min: 0, max: 100_000 }),
				(first, second, later) => {
					const state = first === 'ante' ? anteStarted() : pvpStarted()
					const bobBefore = runOf(state)
					const result = send(
						state,
						'bob',
						{ kind: 'timerStart', timer: second },
						later,
					)
					expect(result.refusals).toEqual(['being_timed'])
					expect(result.state.run).toEqual(bobBefore)
					expect(canStartTimer(result.state, 'bob')).toBe(false)
					expect(startedFor(result.state, 'ann', first)).toEqual([])
				},
			),
		)
	})

	it('being timed counts only while the countdown runs: the starter pausing frees the target', () => {
		const state = pvpStarted()
		const paused = send(state, 'ann', { kind: 'timerPause' }, 2000).state
		expect(refusalsOf(paused, 'bob', 'pvp')).not.toContain('being_timed')
	})

	it('a countdown held because its target is animating still counts as being timed', () => {
		const state = pvpStarted()
		const held = send(state, 'bob', { kind: 'animating', on: true }, 2000).state
		expect(countdownsOf(held)[0].hold.kind).toBe('held for player')
		expect(refusalsOf(held, 'bob', 'pvp')).toEqual(['being_timed'])
	})
})

describe('timerPause', () => {
	it('only the starter stops the timer, and starting again resumes it', () => {
		const state = pvpStarted()
		const refused = send(state, 'bob', { kind: 'timerPause' }, 5000)
		expect(refused.refusals).toEqual(['no_timer_to_pause'])
		const paused = send(state, 'ann', { kind: 'timerPause' }, 11_000).state
		expect(countdownsOf(paused)[0]).toMatchObject({
			hold: { kind: 'paused by starter', sinceAt: 11_000 },
			endsAt: 61_000,
		})
		const resumed = start(paused, 'ann', 'pvp', 20_000).state
		expect(countdownsOf(resumed)[0]).toMatchObject({
			hold: { kind: 'counting' },
			endsAt: 70_000,
		})
	})

	it('a countdown already paused by its starter cannot be paused again', () => {
		const paused = send(pvpStarted(), 'ann', { kind: 'timerPause' }, 2000).state
		expect(send(paused, 'ann', { kind: 'timerPause' }, 3000).refusals).toEqual([
			'no_timer_to_pause',
		])
	})

	it('pause_conserves_time: pausing and resuming keeps the time left', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: 0, max: 500_000 }),
				(pausedAfter, pausedFor) => {
					const state = pvpStarted()
					const pausedAt = 1000 + pausedAfter
					const paused = send(
						state,
						'ann',
						{ kind: 'timerPause' },
						pausedAt,
					).state
					const left = countdownsOf(paused)[0].endsAt - pausedAt
					const resumeAt = pausedAt + pausedFor
					const resumed = start(paused, 'ann', 'pvp', resumeAt).state
					expect(countdownsOf(resumed)[0].endsAt - resumeAt).toBe(left)
				},
			),
		)
	})
})

describe('hand time', () => {
	const bobEnds = (state: State): number => countdownsOf(state)[0].endsAt

	it('each hand the timed player plays adds the hand time', () => {
		const state = pvpStarted()
		const once = played(state, 'bob', 3, 5000)
		expect(bobEnds(once)).toBe(
			1000 + PVP.baseMilliseconds + PVP.handMilliseconds,
		)
		expect(bobEnds(once)).toBe(76_000)
		const twice = played(once, 'bob', 2, 6000)
		expect(bobEnds(twice)).toBe(91_000)
	})

	it('a hand played after a hand was gained still adds its hand time', () => {
		const first = scored(
			played(pvpStarted(), 'bob', 3, 5000),
			'bob',
			'3',
			3,
			5500,
		)
		expect(bobEnds(first)).toBe(76_000)
		expect(bobEnds(played(first, 'bob', 4, 6000))).toBe(91_000)
	})

	it('a hand played after the time is up adds nothing, at the last millisecond it does', () => {
		const endsAt = bobEnds(pvpStarted())
		expect(bobEnds(played(pvpStarted(), 'bob', 3, endsAt + 5000))).toBe(endsAt)
		expect(bobEnds(played(pvpStarted(), 'bob', 3, endsAt))).toBe(endsAt)
		expect(bobEnds(played(pvpStarted(), 'bob', 3, endsAt - 1))).toBe(
			endsAt + PVP.handMilliseconds,
		)
	})

	it('a hand the starter plays adds nothing', () => {
		const state = pvpStarted()
		expect(bobEnds(played(state, 'ann', 2, 5000))).toBe(
			1000 + PVP.baseMilliseconds,
		)
	})

	it('a countdown the starter paused gets the hand time too, so resuming matches the bank', () => {
		const paused = send(pvpStarted(), 'ann', { kind: 'timerPause' }, 2000).state
		const before = bobEnds(paused)
		expect(bobEnds(played(paused, 'bob', 3, 5000))).toBe(
			before + PVP.handMilliseconds,
		)
	})

	it('a countdown held because the target animates still gets it', () => {
		const held = send(
			pvpStarted(),
			'bob',
			{ kind: 'animating', on: true },
			2000,
		).state
		const before = bobEnds(held)
		expect(bobEnds(played(held, 'bob', 3, 3000))).toBe(
			before + PVP.handMilliseconds,
		)
	})

	it('an Ante timer is gone once the PvP blind plays, so it gets no hand time', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const withAnte: State = {
			...state,
			run: {
				...run,
				clocks: startCountdown(
					run.clocks,
					{
						kind: 'ante',
						by: 'ann',
						against: ['bob'],
						lengthMilliseconds: BASE,
						blindKey: BLIND,
					},
					0,
				),
			},
		}
		const after = played(withAnte, 'bob', 3, 5000)
		const kinds = (kind: string) =>
			countdownsOf(after).filter((countdown) => countdown.kind === kind)
		expect(kinds('ante').map((countdown) => countdown.endsAt)).toEqual([])
		expect(kinds('pvp').map((countdown) => countdown.endsAt)).toEqual([76_000])
	})

	it('only the timed player moves the countdown, whatever order hands come in', () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom('ann', 'bob'), { maxLength: 3 }),
				(order) => {
					let state = pvpStarted()
					let handsLeft = { ann: 3, bob: 4 }
					for (const player of order) {
						const left = handsLeft[player as 'ann' | 'bob'] - 1
						state = played(state, player, left, 2000)
						handsLeft = { ...handsLeft, [player]: left }
					}
					const bobHands = order.filter((player) => player === 'bob').length
					expect(bobEnds(state)).toBe(
						1000 + PVP.baseMilliseconds + bobHands * PVP.handMilliseconds,
					)
				},
			),
		)
	})
})

describe('PvP time bank', () => {
	const banksOf = (state: State) => runOf(state).currentPvpBlind?.banks
	const pause = (state: State, now: number) =>
		send(state, 'ann', { kind: 'timerPause' }, now).state

	it('every player starts with the PvP base time, and the view shows it', () => {
		const state = inPvpBlind()
		expect(banksOf(state)).toEqual({
			ann: PVP.baseMilliseconds,
			bob: PVP.baseMilliseconds,
		})
		expect(timersViewAtSettle(state, 'ann').pvpBanks).toEqual(banksOf(state))
	})

	it('there is no bank without the PvP timer or outside a PvP blind', () => {
		expect(banksOf(inPvpBlind(['ann', 'bob'], {}))).toEqual({})
		expect(
			timersViewAtSettle(runOfMode(['ann', 'bob'], 'nemesis'), 'ann').pvpBanks,
		).toEqual({})
	})

	it('each hand adds the hand time, timed or not', () => {
		let state = inPvpBlind()
		state = played(state, 'bob', 3, 1000)
		state = played(state, 'bob', 2, 2000)
		expect(banksOf(state)?.bob).toBe(
			PVP.baseMilliseconds + 2 * PVP.handMilliseconds,
		)
		expect(banksOf(state)?.ann).toBe(PVP.baseMilliseconds)
	})

	it('a press after two untimed hands starts at base plus two hand times', () => {
		let state = scored(inPvpBlind(), 'ann', '5')
		state = played(state, 'bob', 3, 1000)
		state = played(state, 'bob', 2, 2000)
		state = start(state, 'ann', 'pvp', 3000).state
		expect(countdownsOf(state)[0].endsAt).toBe(
			3000 + PVP.baseMilliseconds + 2 * PVP.handMilliseconds,
		)
	})

	it('pausing writes the time left back to the bank, and resuming counts from it', () => {
		const paused = pause(pvpStarted(), 11_000)
		expect(banksOf(paused)?.bob).toBe(PVP.baseMilliseconds - 10_000)
		const grown = played(paused, 'bob', 3, 12_000)
		expect(banksOf(grown)?.bob).toBe(
			PVP.baseMilliseconds - 10_000 + PVP.handMilliseconds,
		)
		const resumed = start(grown, 'ann', 'pvp', 20_000).state
		expect(countdownsOf(resumed)[0].endsAt - 20_000).toBe(banksOf(grown)?.bob)
	})

	it('the timed player scoring past the starter stops the countdown and banks the time left', () => {
		const state = scored(pvpStarted(), 'bob', '10', 3, 11_000)
		expect(countdownsOf(state)).toEqual([])
		expect(banksOf(state)?.bob).toBe(PVP.baseMilliseconds - 10_000)
	})

	it('level with the starter, who got there first, keeps the countdown going', () => {
		const state = scored(pvpStarted(), 'bob', '5', 3, 11_000)
		expect(countdownsOf(state)).toHaveLength(1)
	})

	it('a press on a player whose last reported hands are 0 is refused', () => {
		let state = scored(inPvpBlind(), 'ann', '5')
		state = played(state, 'bob', 0, 1000)
		expect(refusalsOf(state, 'ann', 'pvp')).toEqual(['out_of_hands'])
		expect(timerButtonOfAtSettle(state, 'ann')).toBe('none')
	})

	it('a countdown started from a grown bank still ends the timed player at run-out', () => {
		let state = scored(inPvpBlind(), 'ann', '5')
		state = played(state, 'bob', 3, 1000)
		state = start(state, 'ann', 'pvp', 2000).state
		const endsAt = countdownsOf(state)[0].endsAt
		expect(
			runOf(runOutTimers(state, endsAt)).finishedPvpBlinds[0].endedBy.bob,
		).toBe('timer')
	})

	it('a score past the starter after the time is up does not cancel the run-out', () => {
		const state = pvpStarted()
		const endsAt = countdownsOf(state)[0].endsAt
		const scoredLate = scored(state, 'bob', '10', 3, endsAt + 1)
		expect(countdownsOf(scoredLate)).toHaveLength(1)
		expect(
			runOf(runOutTimers(scoredLate, endsAt + 1)).finishedPvpBlinds[0].endedBy
				.bob,
		).toBe('timer')
	})

	it('two starters on one target: a later resume restores no time another starter used', () => {
		const paused = pause(pvpStarted(), 11_000)
		expect(banksOf(paused)?.bob).toBe(50_000)
		const run = runOf(paused)
		const second: State = {
			...paused,
			run: {
				...run,
				clocks: startCountdown(
					run.clocks,
					{
						kind: 'pvp',
						by: 'cat',
						against: ['bob'],
						lengthMilliseconds: 50_000,
					},
					11_000,
				),
			},
		}
		const dropped = dropUnneededTimers(second, 31_000)
		expect(countdownsOf(dropped).map((countdown) => countdown.by)).toEqual([
			'ann',
		])
		expect(banksOf(dropped)?.bob).toBe(30_000)
		const resumed = start(dropped, 'ann', 'pvp', 40_000).state
		expect(countdownsOf(resumed)[0].endsAt).toBe(70_000)
	})
})

describe('paidPreviews', () => {
	function spendable(left: number, cost: number): State {
		const state = runOfMode(['ann', 'bob'], 'nemesis', {
			clocks: {
				ante: 'personal',
				pvp: null,
				personal: { ...PRESSURE, previewCostMilliseconds: cost },
			},
		})
		const run = runOf(state)
		return {
			...state,
			run: {
				...run,
				clocks: startCountdown(
					run.clocks,
					{
						kind: 'personal',
						by: null,
						against: ['ann'],
						lengthMilliseconds: left,
					},
					0,
				),
			},
		}
	}
	const endsAt = (state: State): number => countdownsOf(state)[0].endsAt

	it('takes the cost off the clock for each paid use, counted by run total', () => {
		let state = spendable(100_000, 20_000)
		state = send(state, 'ann', { kind: 'paidPreviews', total: 1 }).state
		expect(endsAt(state)).toBe(80_000)
		const resent = send(state, 'ann', { kind: 'paidPreviews', total: 1 })
		expect(resent.refusals).toEqual([])
		expect(endsAt(resent.state)).toBe(80_000)
		expect(
			endsAt(send(state, 'ann', { kind: 'paidPreviews', total: 3 }).state),
		).toBe(40_000)
	})

	it('is free at or below the floor of 10 s or the cost', () => {
		expect(
			endsAt(
				send(spendable(10_000, 5_000), 'ann', {
					kind: 'paidPreviews',
					total: 1,
				}).state,
			),
		).toBe(10_000)
		expect(
			endsAt(
				send(spendable(30_000, 30_000), 'ann', {
					kind: 'paidPreviews',
					total: 4,
				}).state,
			),
		).toBe(30_000)
	})

	it('charges nothing at exactly the floor and one cost for the first millisecond above it', () => {
		const spend = (left: number, cost: number) =>
			endsAt(
				send(spendable(left, cost), 'ann', { kind: 'paidPreviews', total: 1 })
					.state,
			)
		expect(spend(10_000, 5_000)).toBe(10_000)
		expect(spend(10_001, 5_000)).toBe(5_001)
		expect(spend(30_000, 30_000)).toBe(30_000)
		expect(spend(30_001, 30_000)).toBe(1)
	})

	it('one jump of n uses charges what n single uses charge', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1_000, max: 300_000 }),
				fc.integer({ min: 1, max: 60_000 }),
				fc.integer({ min: 1, max: 25 }),
				(left, cost, uses) => {
					let oracle = left
					for (let use = 0; use < uses; use++)
						if (oracle > Math.max(10_000, cost)) oracle -= cost
					const state = send(spendable(left, cost), 'ann', {
						kind: 'paidPreviews',
						total: uses,
					}).state
					expect(endsAt(state)).toBe(oracle)
					expect(endsAt(state)).toBeGreaterThan(0)
				},
			),
		)
	})

	it('refuses a player with no pressure clock: no_timer, nothing written', () => {
		const state = runOfMode(['ann', 'bob'], 'nemesis')
		const out = send(state, 'ann', { kind: 'paidPreviews', total: 2 })
		expect(out.refusals).toEqual(['no_timer'])
		expect(countdownsOf(out.state)).toEqual(countdownsOf(state))
	})

	it('refuses a player whose own pressure clock is not running', () => {
		const state = spendable(100_000, 20_000)
		expect(
			send(state, 'bob', { kind: 'paidPreviews', total: 1 }).refusals,
		).toEqual(['no_timer'])
	})

	it('refuses without a run', () => {
		const state: State = { ...spendable(100_000, 20_000), run: null }
		expect(
			paidPreviewsHandler.handle(state, 'ann', { total: 1 }, 0, null),
		).toEqual({
			refusal: 'no_run',
		})
	})
})

describe('animating', () => {
	it('pauses the countdowns while on and lets them go when off', () => {
		const state = pvpStarted()
		const on = send(state, 'bob', { kind: 'animating', on: true }, 5000).state
		expect(countdownsOf(on)[0]).toMatchObject({
			hold: { kind: 'held for player', sinceAt: 5000 },
		})
		const off = send(on, 'bob', { kind: 'animating', on: false }, 8000).state
		expect(countdownsOf(off)[0]).toMatchObject({
			hold: { kind: 'counting' },
			endsAt: 64_000,
		})
	})

	it('newest wins: the same value twice is the same state', () => {
		const once = send(
			pvpStarted(),
			'bob',
			{ kind: 'animating', on: true },
			5000,
		).state
		const twice = send(once, 'bob', { kind: 'animating', on: true }, 5000).state
		expect(twice.run).toEqual(once.run)
	})

	it('a player out of the run may end a pause, never start one', () => {
		const state = pvpStarted()
		const on = send(state, 'bob', { kind: 'animating', on: true }, 5000).state
		const run = runOf(on)
		const out: State = {
			...on,
			run: {
				...run,
				lives: { ...run.lives, bob: { ...run.lives.bob, status: 'forfeited' } },
			},
		}
		expect(
			send(out, 'bob', { kind: 'animating', on: false }, 6000).refusals,
		).toEqual([])
		const again = send(
			state,
			'bob',
			{ kind: 'animating', on: true },
			5000,
		).state
		const gone: State = {
			...again,
			run: {
				...runOf(again),
				lives: {
					...runOf(again).lives,
					bob: { ...runOf(again).lives.bob, status: 'out' },
				},
			},
		}
		expect(
			send(gone, 'bob', { kind: 'animating', on: true }, 6000).refusals,
		).toEqual(['eliminated'])
	})
})

describe('timersView', () => {
	it('sends an Ante deadline with the shared fields only, never its Boss', () => {
		const deadlines = timersViewAtSettle(anteStarted(), 'ann').deadlines
		expect(deadlines.length).toBeGreaterThan(0)
		for (const deadline of deadlines)
			expect(Object.keys(deadline).sort()).toEqual([
				'against',
				'by',
				'endsAt',
				'hold',
				'kind',
				'pausedAt',
			])
	})

	it('shows a player the countdowns that involve them, in the shared shape', () => {
		let state = pvpStarted(['ann', 'bob'])
		const run = runOf(state)
		state = {
			...state,
			run: {
				...run,
				clocks: startCountdown(
					run.clocks,
					{
						kind: 'personal',
						by: null,
						against: ['ann'],
						lengthMilliseconds: 500,
					},
					0,
				),
			},
		}
		const ann = timersViewAtSettle(state, 'ann')
		expect(ann.deadlines.map((deadline) => deadline.kind).sort()).toEqual([
			'personal',
			'pvp',
		])
		expect(ann.deadlines[0]).not.toHaveProperty('pausedForPlayer')
		expect(
			timersViewAtSettle(state, 'bob')
				.deadlines.map((d) => d.kind)
				.sort(),
		).toEqual(['pvp'])
		expect(timersViewAtSettle(state, 'zed' as string).deadlines).toEqual([])
	})

	it('with no run there is no button and no timers', () => {
		const none = { ...pvpStarted(), run: null }
		expect(timerButtonOfAtSettle(none, 'ann')).toBe('none')
		expect(timersViewAtSettle(none, 'ann')).toEqual({
			timerButton: 'none',
			deadlines: [],
			pauses: [],
			pvpBanks: {},
			anteBanks: {},
		})
	})

	it('timerButton is the same answer the input gets', () => {
		const state = pvpStarted()
		expect(timersViewAtSettle(state, 'bob').timerButton).toBe('none')
		expect(timerButtonOfAtSettle(state, 'ann')).toBe('none')
		const waiting = ready(runOfMode(['ann', 'bob'], 'nemesis'), 'ann').state
		expect(timersViewAtSettle(waiting, 'ann').timerButton).toBe('ante')
		expect(
			timersViewAtSettle(runOfMode(['ann'], 'nemesis'), 'ann').timerButton,
		).toBe('none')
		expect(
			timersViewAtSettle(scored(inPvpBlind(), 'ann', '5'), 'ann').timerButton,
		).toBe('pvp')
		expect(
			timersViewAtSettle(
				{ lobbyMode: 'royale', players: {}, run: null, result: null },
				'ann',
			),
		).toEqual({
			timerButton: 'none',
			deadlines: [],
			pauses: [],
			pvpBanks: {},
			anteBanks: {},
		})
	})

	it('lists the pause that is stopping a countdown the viewer sees', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const away: State = {
			...state,
			run: {
				...run,
				clocks: startPlayerPause(run.clocks, 'bob', 'away', LIMITS, 2000),
			},
		}
		expect(timersViewAtSettle(away, 'ann').pauses).toEqual([
			{
				reason: 'away',
				players: ['bob'],
				endsAt: 2000 + LIMITS.awayBudgetMilliseconds,
			},
		])
		expect(timersViewAtSettle(state, 'ann').pauses).toEqual([])
	})

	it('leaves out a pause whose budget is used up', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const away: State = {
			...state,
			run: {
				...run,
				clocks: startPlayerPause(run.clocks, 'bob', 'away', LIMITS, 2000),
			},
		}
		const spent = runOf(away)
		const used: State = {
			...away,
			run: {
				...spent,
				clocks: {
					...spent.clocks,
					players: {
						...spent.clocks.players,
						bob: { ...spent.clocks.players.bob, awayLeftMilliseconds: 0 },
					},
				},
			},
		}
		expect(timersViewAtSettle(away, 'ann').pauses).toHaveLength(1)
		expect(timersViewAtSettle(used, 'ann').pauses).toEqual([])
	})
})

describe('playersWhoLostALife', () => {
	it('counts a seat whose lives went down, never a seat that is gone', () => {
		const before = pvpStarted()
		const run = before.run
		if (run === null) throw new Error('no run')
		const ann = run.lives.ann
		const lives = { ...run.lives, ann: { ...ann, lives: ann.lives - 1 } }
		const down = { ...before, run: { ...run, lives } }
		const { ann: _gone, ...rest } = run.lives
		const missing = { ...before, run: { ...run, lives: rest } }
		expect(playersWhoLostALife(before, down)).toEqual(['ann'])
		expect(playersWhoLostALife(before, missing)).toEqual([])
		expect(playersWhoLostALife(before, { ...before, run: null })).toEqual([])
	})
})

// Main: on a level score the player who pressed Ready first for the Boss is ahead (the timer
// press and the overtake stop); who scored the level first does not matter.
const readiedInBlind = (readyOrder: string[], unreadyFirst = false): State => {
	let state = runOfMode(['ann', 'bob'], 'nemesis', { pvpTimer: true })
	if (unreadyFirst) {
		state = ready(state, readyOrder[0]).state
		state = ready(state, readyOrder[0], false).state
	}
	for (const player of readyOrder) state = ready(state, player).state
	for (const player of ['ann', 'bob']) state = blindStart(state, player)
	return state
}

const level = (state: State, firstToScore: string, second: string): State =>
	scored(scored(state, firstToScore, '7'), second, '7')

describe('a level score: who is ahead', () => {
	it.each<[string, string[], string, string, boolean]>([
		['ann Ready first, ann scored first', ['ann', 'bob'], 'ann', 'bob', true],
		['ann Ready first, bob scored first', ['ann', 'bob'], 'bob', 'ann', true],
		['bob Ready first, ann scored first', ['bob', 'ann'], 'ann', 'bob', false],
		['bob Ready first, bob scored first', ['bob', 'ann'], 'bob', 'ann', false],
	])('%s', (_name, readyOrder, firstToScore, second, annMayStart) => {
		const state = level(readiedInBlind(readyOrder), firstToScore, second)
		expect(canStartTimer(state, 'ann')).toBe(annMayStart)
		expect(canStartTimer(state, 'bob')).toBe(!annMayStart)
	})

	it('un-readying and readying again keeps the first place', () => {
		const state = readiedInBlind(['bob', 'ann'], true)
		const tied = level(state, 'ann', 'bob')
		expect(canStartTimer(tied, 'bob')).toBe(true)
		expect(canStartTimer(tied, 'ann')).toBe(false)
	})

	it('the overtake stop: level with the starter keeps the countdown only when the starter Readied first', () => {
		const kept = (readyOrder: string[]): number => {
			const ahead = scored(readiedInBlind(readyOrder), 'ann', '5')
			const started = start(ahead, 'ann', 'pvp', 1000).state
			return countdownsOf(scored(started, 'bob', '5', 3, 2000)).length
		}
		expect(kept(['ann', 'bob'])).toBe(1)
		expect(kept(['bob', 'ann'])).toBe(0)
	})

	it('the player who Readied first is recorded, and cleared once the PvP blind closes', () => {
		const state = readiedInBlind(['ann', 'bob'])
		expect(runOf(state).firstReady).toEqual(['ann'])
		const over = scored(scored(state, 'ann', '5', 0), 'bob', '3', 0)
		expect(runOf(over).currentPvpBlind).toBeNull()
		expect(runOf(over).firstReady).toEqual([])
	})

	it('with three players nobody is marked first', () => {
		const state = ready(runOfMode(['ann', 'bob', 'cat'], 'royale'), 'ann').state
		expect(runOf(state).firstReady).toEqual([])
	})
})
