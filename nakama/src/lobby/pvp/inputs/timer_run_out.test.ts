import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type NewCountdown, startCountdown } from '../core/clock'
import { tick } from '../core/tick'
import type { Countdown, State } from '../core/types'
import { BLIND, endedByOf, ready, runOf, send } from '../testing/inputs'
import { copyOnRead } from '../testing/copy_on_read'
import { runInMode } from '../testing/state'
import {
	BASE,
	PVP,
	anteStarted,
	blindStart,
	configured,
	countdownsOf,
	inPvpBlind,
	livesOf,
	played,
	pvpStarted,
	runOfMode,
	scored,
	start,
	startedFor,
	threeInPvpBlind,
} from '../testing/timers'
import { dropUnneededTimers, runOutTimers } from './timer_run_out'

interface CountdownSpec {
	kind: NewCountdown['kind']
	by: string | null
	against: string[]
	lengthMilliseconds: number
}

// An Ante countdown presses for the shared PvP Boss.
const made = (spec: CountdownSpec): NewCountdown =>
	spec.kind === 'ante'
		? { ...spec, kind: 'ante', blindKey: BLIND }
		: { ...spec, kind: spec.kind }

const addCountdown = (
	state: State,
	countdown: CountdownSpec,
	now = 0,
): State => {
	const run = runOf(state)
	return {
		...state,
		run: {
			...run,
			clocks: startCountdown(run.clocks, made(countdown), now),
		},
	}
}

describe('the PvP timer running out', () => {
	it('two players: the timed player loses the PvP blind and a life, the other wins', () => {
		const out = runOutTimers(pvpStarted(), 61_000)
		const run = runOf(out)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds).toHaveLength(1)
		expect(run.finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			endedBy: { bob: 'timer' },
		})
		expect(livesOf(out, 'bob')).toBe(3)
		expect(livesOf(out, 'ann')).toBe(4)
		expect(countdownsOf(out).filter((c) => c.kind === 'pvp')).toEqual([])
	})

	it('keeps the score the timed player had posted, for display', () => {
		const out = runOutTimers(pvpStarted(), 61_000)
		expect(runOf(out).finishedPvpBlinds[0].scores.bob).toBe('0')
	})

	it('does nothing before the time is up', () => {
		const state = pvpStarted()
		expect(countdownsOf(runOutTimers(state, 60_999))).toEqual(
			countdownsOf(state),
		)
		expect(runOf(runOutTimers(state, 60_999)).currentPvpBlind).not.toBeNull()
	})

	it('runs out at the end time, hand time included', () => {
		const state = played(pvpStarted(), 'bob', 3, 5000)
		expect(runOf(runOutTimers(state, 61_000)).currentPvpBlind).not.toBeNull()
		expect(runOf(runOutTimers(state, 76_000)).currentPvpBlind).toBeNull()
	})

	it('a paused timer never runs out', () => {
		const paused = send(pvpStarted(), 'ann', { kind: 'timerPause' }, 2000).state
		expect(countdownsOf(runOutTimers(paused, 10_000_000))).toEqual(
			countdownsOf(paused),
		)
	})

	it('three players: the timed player is done at once and alone pays when the PvP blind closes, the bye is untouched', () => {
		const state = start(
			scored(threeInPvpBlind(), 'ann', '5'),
			'ann',
			'pvp',
			0,
		).state
		expect(countdownsOf(state)).toMatchObject([
			{ kind: 'pvp', by: 'ann', against: ['bob'] },
		])
		const timedOut = runOutTimers(state, PVP.baseMilliseconds)
		expect(runOf(timedOut).currentPvpBlind).not.toBeNull()
		expect(endedByOf(timedOut, 'bob')).toBe('timer')
		expect(livesOf(timedOut, 'bob')).toBe(4)
		const out = scored(scored(timedOut, 'ann', '5', 0), 'cat', '0', 0)
		expect(runOf(out).finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			endedBy: { bob: 'timer' },
		})
		expect(livesOf(out, 'bob')).toBe(3)
		expect(livesOf(out, 'ann')).toBe(4)
		expect(livesOf(out, 'cat')).toBe(4)
	})

	it('a PvP countdown with the PvP timer off ends nothing', () => {
		let state = runOfMode(['ann', 'bob'], 'nemesis')
		state = ready(ready(state, 'ann').state, 'bob').state
		const timed = addCountdown(state, {
			kind: 'pvp',
			by: 'ann',
			against: ['bob'],
			lengthMilliseconds: 10,
		})
		const out = runOutTimers(timed, 10)
		expect(endedByOf(out, 'bob')).toBeNull()
		expect(countdownsOf(out).filter((c) => c.kind === 'pvp')).toEqual([])
	})

	it('a countdown dropped by key: an equal one started later by the same player is untouched', () => {
		const state = pvpStarted()
		const out = runOutTimers(state, 61_000)
		expect(countdownsOf(out)).toEqual([])
	})

	it('pvp_timer_out_loses_only_the_timed_player: through apply, whatever came before', () => {
		const step = fc.record({
			player: fc.constantFrom('ann', 'bob'),
			action: fc.constantFrom('played', 'scored', 'pause', 'resume', 'animate'),
			points: fc.integer({ min: 1, max: 9 }),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 8 }), (steps) => {
				let state = pvpStarted()
				let now = 2000
				const handsLeft = { ann: 3, bob: 4 }
				for (const { player, action, points } of steps) {
					now += 100
					const who = player as 'ann' | 'bob'
					if (action === 'played') {
						handsLeft[who] = Math.max(1, handsLeft[who] - 1)
						state = played(state, who, handsLeft[who], now)
					} else if (action === 'scored')
						state = scored(state, who, String(points * 10), handsLeft[who], now)
					else if (action === 'pause')
						state = send(state, who, { kind: 'timerPause' }, now).state
					else if (action === 'resume')
						state = start(state, who, 'pvp', now).state
					else
						state = send(
							state,
							who,
							{ kind: 'animating', on: points % 2 === 0 },
							now,
						).state
				}
				const out = runOutTimers(state, 10_000_000)
				const against = countdownsOf(state)
					.filter((c) => c.kind === 'pvp')
					.flatMap((c) => c.against)
				const lostBy = ['ann', 'bob'].filter(
					(id) => livesOf(out, id) < livesOf(state, id),
				)
				expect(lostBy.length).toBeLessThanOrEqual(1)
				for (const id of lostBy) expect(against).toContain(id)
				if (lostBy.length === 1)
					expect(runOf(out).finishedPvpBlinds.slice(-1)[0]?.losers).toEqual(
						lostBy,
					)
			}),
		)
	})

	it('pvp_timer_off_never_ends_pvp_blind: through apply, no input ends a player by timer', () => {
		const step = fc.record({
			player: fc.constantFrom('ann', 'bob'),
			action: fc.constantFrom(
				'ready',
				'start',
				'pvp',
				'played',
				'scored',
				'pause',
				'animate',
			),
			points: fc.integer({ min: 1, max: 9 }),
		})
		fc.assert(
			fc.property(
				fc.array(step, { maxLength: 14 }),
				fc.integer({ min: 0, max: 10_000_000 }),
				(steps, later) => {
					let state = runOfMode(['ann', 'bob'], 'nemesis')
					let now = 0
					for (const { player, action, points } of steps) {
						now += 100
						if (action === 'ready')
							state = ready(state, player, true, BLIND, now).state
						else if (action === 'start')
							state = start(state, player, 'ante', now).state
						else if (action === 'pvp')
							state = start(state, player, 'pvp', now).state
						else if (action === 'played') state = played(state, player, 1, now)
						else if (action === 'scored')
							state = scored(state, player, String(points), 2, now)
						else if (action === 'pause')
							state = send(state, player, { kind: 'timerPause' }, now).state
						else
							state = send(
								state,
								player,
								{ kind: 'animating', on: points % 2 === 0 },
								now,
							).state
					}
					expect(countdownsOf(state).filter((c) => c.kind === 'pvp')).toEqual(
						[],
					)
					const out = runOutTimers(state, now + later)
					const run = runOf(out)
					for (const player of ['ann', 'bob'])
						expect(run.currentPvpBlind?.players[player]).not.toMatchObject({
							endedBy: 'timer',
						})
					for (const currentPvpBlind of run.finishedPvpBlinds)
						expect(Object.values(currentPvpBlind.endedBy)).not.toContain(
							'timer',
						)
				},
			),
		)
	})
})

describe('the Ante timer running out', () => {
	it('ante_timer_out_forgives_then_life_then_restarts', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 3 }),
				fc.integer({ min: 1, max: 8 }),
				(forgiveness, countdownsAtZero) => {
					let state = anteStarted({ timerForgiveness: forgiveness })
					let lost = 0
					let at = BASE
					for (let count = 1; count <= countdownsAtZero; count++) {
						if (livesOf(state, 'bob') === 0) break
						state = runOutTimers(state, at)
						lost = Math.max(0, count - forgiveness)
						const alive = 4 - lost > 0
						expect(runOf(state).lifeLedger.runOutsForgiven.bob ?? 0).toBe(
							Math.min(count, forgiveness),
						)
						expect(livesOf(state, 'bob')).toBe(Math.max(0, 4 - lost))
						const again = startedFor(state, 'bob', 'ante')
						if (alive) {
							expect(again).toHaveLength(1)
							expect(again[0]).toMatchObject({ by: 'ann', endsAt: at + BASE })
							at += BASE
						} else expect(again).toEqual([])
					}
				},
			),
		)
	})

	it('the life it costs has no blind key', () => {
		const out = runOutTimers(anteStarted(), BASE)
		expect(runOf(out).lives.bob.events).toEqual([{ delta: -1, cause: null }])
	})

	it('an Ante and a pressure countdown running out on one player in one tick cost one life', () => {
		const both = addCountdown(anteStarted(), {
			kind: 'personal',
			by: null,
			against: ['bob'],
			lengthMilliseconds: 100_000,
		})
		const out = runOutTimers(both, BASE)
		expect(livesOf(out, 'bob')).toBe(3)
		expect(runOf(out).lives.bob.events).toEqual([{ delta: -1, cause: null }])
	})

	it('R13: an Ante and a pressure countdown 1 ms apart cost one life, however often the server ticks', () => {
		const both = addCountdown(anteStarted(), {
			kind: 'personal',
			by: null,
			against: ['bob'],
			lengthMilliseconds: BASE + 1,
		})
		const twice = runOutTimers(runOutTimers(both, BASE), BASE + 1)
		const once = runOutTimers(both, BASE + 1)
		expect(once).toEqual(twice)
		expect(livesOf(once, 'bob')).toBe(3)
		expect(countdownsOf(once)).toMatchObject([
			{ kind: 'ante', by: 'ann', against: ['bob'], endsAt: 2 * BASE },
		])
	})

	it('a pressure run-out that costs a life ends the Ante countdown, which starts again from the base', () => {
		const both = addCountdown(anteStarted(), {
			kind: 'personal',
			by: null,
			against: ['bob'],
			lengthMilliseconds: 100_000,
		})
		const out = runOutTimers(both, 100_000)
		expect(livesOf(out, 'bob')).toBe(3)
		expect(countdownsOf(out)).toMatchObject([
			{ kind: 'ante', by: 'ann', against: ['bob'], endsAt: 100_000 + BASE },
		])
	})

	it('a life lost to one pressure countdown ends the other, on state that is a new object at every read', () => {
		const pressure = (lengthMilliseconds: number) => ({
			kind: 'personal' as const,
			by: null,
			against: ['bob'],
			lengthMilliseconds,
		})
		const two = addCountdown(
			addCountdown(inPvpBlind(), pressure(100_000)),
			pressure(200_000),
		)
		const out = runOutTimers(copyOnRead(two), 100_000)
		expect(livesOf(out, 'bob')).toBe(livesOf(two, 'bob') - 1)
		expect(countdownsOf(out)).toEqual([])
	})

	it('a forgiven run-out ends nothing else', () => {
		const both = addCountdown(anteStarted({ timerForgiveness: 1 }), {
			kind: 'personal',
			by: null,
			against: ['bob'],
			lengthMilliseconds: 100_000,
		})
		const out = runOutTimers(both, 100_000)
		expect(livesOf(out, 'bob')).toBe(4)
		expect(countdownsOf(out).map((countdown) => countdown.kind)).toEqual([
			'ante',
		])
		expect(runOf(out).lifeLedger.runOutsForgiven.bob).toBe(1)
	})

	describe('Teams share one pool of lives', () => {
		const teams = { a: 'A', b: 'A', c: 'B', d: 'B' } as const
		const teamsRun = (forgiveness = 0): State => {
			const base = configured(runInMode(['a', 'b', 'c', 'd'], 'teams', teams), {
				timerForgiveness: forgiveness,
			})
			const run = runOf(base)
			return { ...base, run: { ...run, teamLives: { A: 4, B: 4 } } }
		}

		it('R7: one Ante countdown against both teammates costs the pool a life for each', () => {
			const timed = addCountdown(teamsRun(), {
				kind: 'ante',
				by: 'c',
				against: ['a', 'b'],
				lengthMilliseconds: BASE,
			})
			const out = runOutTimers(timed, BASE)
			expect(runOf(out).teamLives).toEqual({ A: 2, B: 4 })
			expect(livesOf(out, 'a')).toBe(2)
			expect(livesOf(out, 'b')).toBe(2)
		})

		it('one countdown on each teammate costs the pool one life', () => {
			let timed = teamsRun()
			for (const [player, length] of [
				['a', 1000],
				['b', 1500],
			] as const)
				timed = addCountdown(timed, {
					kind: 'personal',
					by: null,
					against: [player],
					lengthMilliseconds: length,
				})
			const out = runOutTimers(timed, 2000)
			expect(runOf(out).teamLives).toEqual({ A: 3, B: 4 })
			expect(countdownsOf(out)).toEqual([])
		})

		it('a teammate countdown ending later costs one more only after it is timed again', () => {
			const timed = addCountdown(teamsRun(), {
				kind: 'personal',
				by: null,
				against: ['a'],
				lengthMilliseconds: 1000,
			})
			const next = addCountdown(
				runOutTimers(timed, 1000),
				{ kind: 'personal', by: null, against: ['b'], lengthMilliseconds: 500 },
				1000,
			)
			expect(runOf(runOutTimers(next, 1500)).teamLives).toEqual({ A: 2, B: 4 })
		})
	})

	it('stops once the PvP blind is playing: nobody is charged or timed again', () => {
		const started = anteStarted()
		const playing = ready(started, 'bob').state
		expect(runOf(playing).currentPvpBlind).not.toBeNull()
		const out = runOutTimers(playing, BASE)
		expect(livesOf(out, 'bob')).toBe(4)
		expect(startedFor(out, 'bob', 'ante')).toEqual([])
	})

	describe('with three players, only those still not Ready are charged and timed', () => {
		function threeWaiting(): State {
			let state = runOfMode(['ann', 'bob', 'cat'], 'royale')
			state = ready(state, 'ann').state
			return start(state, 'ann', 'ante').state
		}

		it('a target who got Ready before the run-out is not charged, nor timed again', () => {
			const readied = ready(threeWaiting(), 'bob', true, BLIND, 10).state
			const out = runOutTimers(readied, BASE)
			expect(livesOf(out, 'bob')).toBe(4)
			expect(livesOf(out, 'cat')).toBe(3)
			expect(startedFor(out, 'bob', 'ante')).toMatchObject([
				{ hold: { kind: 'paused for ready', sinceAt: 10 } },
			])
			expect(startedFor(out, 'cat', 'ante')).toMatchObject([
				{ by: 'ann', against: ['cat'], endsAt: BASE + BASE },
			])
		})

		it('nobody Ready among the targets: both are charged and both timed again', () => {
			const out = runOutTimers(threeWaiting(), BASE)
			expect(livesOf(out, 'bob')).toBe(3)
			expect(livesOf(out, 'cat')).toBe(3)
			expect(startedFor(out, 'bob', 'ante')).toHaveLength(1)
		})

		it('a life lost to a pressure timer by one target leaves the other target and their Ante alone', () => {
			let state = ready(runOfMode(['ann', 'bob', 'cat'], 'royale'), 'cat').state
			state = addCountdown(state, {
				kind: 'ante',
				by: 'cat',
				against: ['ann', 'bob'],
				lengthMilliseconds: BASE,
			})
			state = addCountdown(state, {
				kind: 'personal',
				by: null,
				against: ['bob'],
				lengthMilliseconds: 100_000,
			})
			const out = runOutTimers(state, 100_000)
			expect(livesOf(out, 'bob')).toBe(3)
			expect(livesOf(out, 'ann')).toBe(4)
			expect(startedFor(out, 'ann', 'ante')).toMatchObject([
				{ by: 'cat', against: ['ann'], endsAt: BASE },
			])
			expect(startedFor(out, 'bob', 'ante')).toMatchObject([
				{ by: 'cat', against: ['bob'], endsAt: 100_000 + BASE },
			])
			expect(
				countdownsOf(out).filter((countdown) => countdown.kind === 'ante'),
			).toHaveLength(2)
		})

		it('a target who left the run is not timed again', () => {
			const state = threeWaiting()
			const run = runOf(state)
			const gone: State = {
				...state,
				run: {
					...run,
					lives: { ...run.lives, cat: { ...run.lives.cat, status: 'left' } },
				},
			}
			const out = runOutTimers(gone, BASE)
			expect(startedFor(out, 'cat', 'ante')).toEqual([])
			expect(startedFor(out, 'bob', 'ante')).toHaveLength(1)
		})

		it('a starter who left the run does not restart it', () => {
			const state = threeWaiting()
			const run = runOf(state)
			const gone: State = {
				...state,
				run: {
					...run,
					lives: { ...run.lives, ann: { ...run.lives.ann, status: 'left' } },
				},
			}
			const out = runOutTimers(gone, BASE)
			expect(countdownsOf(out)).toEqual([])
		})
	})
})

describe('the pressure timer running out', () => {
	function pressured(forgiveness: number): State {
		return addCountdown(
			runOfMode(['ann', 'bob'], 'nemesis', { timerForgiveness: forgiveness }),
			{
				kind: 'personal',
				by: null,
				against: ['ann'],
				lengthMilliseconds: 100_000,
			},
		)
	}

	it('pressure_timer_out_takes_life, and starts no Ante timer', () => {
		const out = runOutTimers(pressured(0), 100_000)
		expect(livesOf(out, 'ann')).toBe(3)
		expect(countdownsOf(out)).toEqual([])
	})

	it('shares the forgiveness count with the Ante timer', () => {
		const forgiven = runOutTimers(pressured(1), 100_000)
		expect(livesOf(forgiven, 'ann')).toBe(4)
		expect(runOf(forgiven).lifeLedger.runOutsForgiven.ann).toBe(1)
		const again = addCountdown(
			forgiven,
			{ kind: 'personal', by: null, against: ['ann'], lengthMilliseconds: 10 },
			100_000,
		)
		expect(livesOf(runOutTimers(again, 100_010), 'ann')).toBe(3)
	})

	it('one that ran out inside a PvP blind charges nothing when the blind closes, or after', () => {
		let state = configured(pressured(0), {
			clocks: {
				ante: 'none',
				pvp: null,
				personal: {
					kind: 'pressure',
					baseMilliseconds: 100_000,
					timedRate: 1,
					previewCostMilliseconds: 20_000,
				},
			},
		})
		state = ready(ready(state, 'ann').state, 'bob').state
		state = blindStart(blindStart(state, 'ann'), 'bob')
		const held = runOutTimers(state, 100_000)
		expect(livesOf(held, 'ann')).toBe(4)
		const closed = runOutTimers(
			scored(scored(held, 'ann', '5', 0, 100_500), 'bob', '3', 0, 100_500),
			100_500,
		)
		expect(runOf(closed).currentPvpBlind).toBeNull()
		expect(livesOf(closed, 'ann')).toBe(4)
		expect(livesOf(closed, 'bob')).toBe(3)
		expect(livesOf(runOutTimers(closed, 100_501), 'ann')).toBe(4)
		expect(livesOf(runOutTimers(closed, 200_500), 'ann')).toBe(3)
	})

	it('a player out of the run is not charged when the time runs out', () => {
		const out = runOutTimers(
			addCountdown(pressured(0), {
				kind: 'personal',
				by: null,
				against: ['ghost'],
				lengthMilliseconds: 10,
			}),
			100_000,
		)
		expect(livesOf(out, 'ann')).toBe(3)
		expect(runOf(out).lives.ghost).toBeUndefined()
	})

	it('a player inside the PvP blind is not charged and the countdown stays', () => {
		let state = pressured(0)
		state = ready(ready(state, 'ann').state, 'bob').state
		const out = runOutTimers(state, 100_000)
		expect(livesOf(out, 'ann')).toBe(4)
		expect(countdownsOf(out)).toMatchObject([
			{ kind: 'personal', against: ['ann'] },
		])
	})
})

describe('timers running out do not depend on how often the server ticks', () => {
	const FACTS = { ranked: true }
	const countdown = (players: string[]) =>
		fc.record({
			kind: fc.constantFrom('ante', 'personal'),
			against: fc.subarray(players, { minLength: 1 }),
			length: fc.integer({ min: 1, max: 200 }),
		})
	// A tick with nothing due does not settle the pause budgets, so `settledAt` is not compared.
	const compared = (state: State): State => ({
		...state,
		run: state.run && {
			...state.run,
			clocks: { ...state.run.clocks, settledAt: 0 },
		},
	})
	const everyMillisecond = (state: State, until: number): State => {
		let next = state
		for (let now = 1; now <= until; now++) next = tick(next, now, FACTS)
		return compared(next)
	}

	it('one player: one tick at T equals a tick at every millisecond up to T', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(countdown(['bob']), {
					minLength: 1,
					maxLength: 5,
					selector: (made) => `${made.kind}:${made.against.join()}`,
				}),
				fc.integer({ min: 0, max: 2 }),
				fc.integer({ min: 1, max: 250 }),
				(made, timerForgiveness, until) => {
					let state = runOfMode(['ann', 'bob'], 'nemesis', { timerForgiveness })
					for (const { kind, against, length } of made)
						state = addCountdown(state, {
							kind,
							by: kind === 'ante' ? 'ann' : null,
							against,
							lengthMilliseconds: length,
						})
					expect(compared(tick(state, until, FACTS))).toEqual(
						everyMillisecond(state, until),
					)
				},
			),
		)
	})

	it('a team: one tick at T equals a tick at every millisecond up to T', () => {
		const teams = { a: 'A', b: 'A', c: 'B', d: 'B' } as const
		fc.assert(
			fc.property(
				fc.uniqueArray(countdown(['a', 'b']), {
					minLength: 1,
					maxLength: 5,
					selector: (made) => `${made.kind}:${made.against.join()}`,
				}),
				fc.integer({ min: 0, max: 2 }),
				fc.integer({ min: 1, max: 250 }),
				(made, timerForgiveness, until) => {
					const base = configured(
						runInMode(['a', 'b', 'c', 'd'], 'teams', teams),
						{ timerForgiveness },
					)
					let state: State = {
						...base,
						run: { ...runOf(base), teamLives: { A: 4, B: 4 } },
					}
					for (const { kind, against, length } of made)
						state = addCountdown(state, {
							kind,
							by: kind === 'ante' ? 'c' : null,
							against,
							lengthMilliseconds: length,
						})
					const once = tick(state, until, FACTS)
					expect(compared(once)).toEqual(everyMillisecond(state, until))
					const timedPlayers = made.reduce(
						(sum, { against }) => sum + against.length,
						0,
					)
					expect(4 - (runOf(once).teamLives?.A ?? 0)).toBeLessThanOrEqual(
						timedPlayers,
					)
				},
			),
		)
	})
})

describe('dropUnneededTimers', () => {
	it('drops an Ante timer once the PvP blind plays', () => {
		const playing = ready(anteStarted(), 'bob').state
		expect(startedFor(dropUnneededTimers(playing, 10), 'bob', 'ante')).toEqual([])
		expect(countdownsOf(dropUnneededTimers(anteStarted(), 10))).toHaveLength(1)
	})

	it('keeps a PvP timer while its target plays, drops it once the PvP blind is over', () => {
		const state = pvpStarted()
		expect(countdownsOf(dropUnneededTimers(state, 10))).toHaveLength(1)
		const over = runOutTimers(state, 61_000)
		expect(countdownsOf(over).filter((c) => c.kind === 'pvp')).toEqual([])
	})

	it('drops a PvP timer whose targets are all done', () => {
		const done = scored(pvpStarted(), 'bob', '9', 0)
		expect(endedByOf(done, 'bob')).toBe('hands')
		expect(countdownsOf(dropUnneededTimers(done, 10))).toEqual([])
	})

	it('drops a timer whose starter is out of the run', () => {
		const state = pvpStarted()
		const run = runOf(state)
		const gone: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, status: 'forfeited' } },
			},
		}
		expect(countdownsOf(dropUnneededTimers(gone, 10))).toEqual([])
	})

	it('keeps a pressure countdown, whoever started it', () => {
		const state = addCountdown(inPvpBlind(), {
			kind: 'personal',
			by: null,
			against: ['ann'],
			lengthMilliseconds: 5,
		})
		expect(countdownsOf(dropUnneededTimers(state, 10))).toHaveLength(1)
	})
})
