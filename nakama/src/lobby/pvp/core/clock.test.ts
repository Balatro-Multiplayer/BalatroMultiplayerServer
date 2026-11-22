import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { copyOnRead } from '../testing/copy_on_read'
import { LIMITS, frozenRules, runState } from '../testing/state'
import {
	awayForfeitAt,
	endPlayerPause,
	newClocks,
	pauseCountdowns,
	removeCountdowns,
	resumeCountdowns,
	countdownsAtZero,
	catchUpClocks,
	shiftTimes,
	startCountdown,
	startPlayerPause,
	stoppedAt,
	timeLeft,
} from './clock'
import type { Clocks, PlayerPause, PvpLimits, State } from './types'

const PLAYERS = ['ann', 'bob']
const SMALL: PvpLimits = {
	animatingHoldMilliseconds: 30,
	animatingBlindMilliseconds: 60,
	awayBudgetMilliseconds: 100,
}
const ante = (lengthMilliseconds: number) => ({
	kind: 'ante' as const,
	by: 'bob',
	against: ['ann'],
	lengthMilliseconds,
	blindKey: '1:Boss',
})
const pvp = (lengthMilliseconds: number) => ({
	kind: 'pvp' as const,
	by: 'bob',
	against: ['ann'],
	lengthMilliseconds,
})
const all = () => true

type Op =
	| { op: 'wait'; milliseconds: number }
	| { op: 'start'; kind: 'ante' | 'pvp' | 'personal'; length: number }
	| { op: 'startPlayerPause'; player: string; reason: PlayerPause['reason'] }
	| { op: 'endPlayerPause'; player: string; reason: PlayerPause['reason'] }
	| { op: 'pause' }
	| { op: 'resume' }

const player = fc.constantFrom(...PLAYERS)
const reason = fc.constantFrom<PlayerPause['reason']>('away', 'animating')
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			op: fc.constant<'wait'>('wait'),
			milliseconds: fc.nat({ max: 80 }),
		}),
	},
	fc.record({
		op: fc.constant<'start'>('start'),
		kind: fc.constantFrom<'ante' | 'pvp' | 'personal'>(
			'ante',
			'pvp',
			'personal',
		),
		length: fc.integer({ min: 1, max: 400 }),
	}),
	fc.record({
		op: fc.constant<'startPlayerPause'>('startPlayerPause'),
		player,
		reason,
	}),
	fc.record({
		op: fc.constant<'endPlayerPause'>('endPlayerPause'),
		player,
		reason,
	}),
	fc.constant<Op>({ op: 'pause' }),
	fc.constant<Op>({ op: 'resume' }),
)
const ops = fc.array(opArbitrary, { maxLength: 40 })

function play(
	list: Op[],
	limits: PvpLimits = SMALL,
): { clocks: Clocks; now: number } {
	let clocks = newClocks(PLAYERS, limits, 0)
	let now = 0
	for (const step of list) {
		switch (step.op) {
			case 'wait':
				now += step.milliseconds
				clocks = catchUpClocks(clocks, now)
				break
			case 'start':
				clocks = startCountdown(
					clocks,
					step.kind === 'ante'
						? {
								kind: 'ante',
								by: null,
								against: ['ann'],
								lengthMilliseconds: step.length,
								blindKey: '1:Boss',
							}
						: {
								kind: step.kind,
								by: null,
								against: ['ann'],
								lengthMilliseconds: step.length,
							},
					now,
				)
				break
			case 'startPlayerPause':
				clocks = startPlayerPause(clocks, step.player, step.reason, limits, now)
				break
			case 'endPlayerPause':
				clocks = endPlayerPause(clocks, step.player, step.reason, now)
				break
			case 'pause':
				clocks = pauseCountdowns(clocks, all, now)
				break
			case 'resume':
				clocks = resumeCountdowns(clocks, all, now)
				break
		}
	}
	return { clocks, now }
}

const inState = (state: State, clocks: Clocks): State =>
	state.run === null ? state : { ...state, run: { ...state.run, clocks } }

describe('pause_conserves_time', () => {
	it('an away stop never costs the countdown time left, however long it lasts', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.nat({ max: 1_000_000 }),
				fc.nat({ max: 700_000 }),
				(length, startOffset, held) => {
					const startAt = Math.min(startOffset, length)
					const budget = LIMITS.awayBudgetMilliseconds
					let clocks = newClocks(PLAYERS, LIMITS, 0)
					clocks = startCountdown(clocks, ante(length), 0)
					clocks = startPlayerPause(clocks, 'ann', 'away', LIMITS, startAt)
					const before = length - startAt
					clocks = endPlayerPause(clocks, 'ann', 'away', startAt + held)
					expect(timeLeft(clocks.countdowns[0], startAt + held)).toBe(before)
					expect(clocks.players.ann.awayLeftMilliseconds).toBe(
						budget - Math.min(held, budget),
					)
					expect(clocks.players.bob.awayLeftMilliseconds).toBe(budget)
				},
			),
		)
	})

	it('the countdown own pause and resume costs nothing either', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5000 }),
				fc.nat({ max: 5000 }),
				fc.nat({ max: 5000 }),
				(length, at, held) => {
					const start = startCountdown(
						newClocks(PLAYERS, LIMITS, 0),
						ante(length),
						0,
					)
					const paused = pauseCountdowns(start, all, at)
					const resumed = resumeCountdowns(paused, all, at + held)
					expect(timeLeft(paused.countdowns[0], at + held)).toBe(length - at)
					expect(timeLeft(resumed.countdowns[0], at + held)).toBe(length - at)
				},
			),
		)
	})
})

describe('away_budget_charged_per_player', () => {
	const limits: PvpLimits = { ...SMALL, awayBudgetMilliseconds: 100 }
	function twoAway(now: number): Clocks {
		let clocks = startCountdown(newClocks(PLAYERS, limits, 0), ante(1000), 0)
		clocks = startPlayerPause(clocks, 'ann', 'away', limits, 0)
		clocks = startPlayerPause(clocks, 'bob', 'away', limits, 40)
		return catchUpClocks(clocks, now)
	}

	it.each<[number, number, number, number, number | null]>([
		// now, ann left, bob left, endsAt, pausedAt
		[40, 60, 100, 1000, 0],
		[70, 30, 70, 1000, 0],
		[100, 0, 40, 1000, 0],
		[120, 0, 20, 1000, 0],
		[140, 0, 0, 1000, 0],
		[500, 0, 0, 1000, 0],
	])(
		'at %i: ann %i, bob %i, ends at %i, paused at %s',
		(now, annLeft, bobLeft, endsAt, pausedAt) => {
			const clocks = twoAway(now)
			expect(clocks.players.ann.awayLeftMilliseconds).toBe(annLeft)
			expect(clocks.players.bob.awayLeftMilliseconds).toBe(bobLeft)
			expect(clocks.countdowns[0].endsAt).toBe(endsAt)
			expect(stoppedAt(clocks.countdowns[0])).toBe(pausedAt)
		},
	)

	it('is charged on state that is a new object at every read, as Nakama hands it back', () => {
		let clocks = startCountdown(newClocks(PLAYERS, limits, 0), ante(1000), 0)
		clocks = startPlayerPause(clocks, 'bob', 'away', limits, 0)
		const settled = catchUpClocks(copyOnRead(clocks), 30)
		expect(settled.players.bob.awayLeftMilliseconds).toBe(70)
		const back = endPlayerPause(copyOnRead(clocks), 'bob', 'away', 30)
		expect(back.players.bob.awayLeftMilliseconds).toBe(70)
	})

	it('a player that was never away keeps its whole budget', () => {
		const clocks = twoAway(500)
		expect(clocks.players.bob.animatingBlindLeftMilliseconds).toBe(
			limits.animatingBlindMilliseconds,
		)
	})
})

describe('away_budget_spent_countdowns_stay_held', () => {
	it('a spent player holds the countdowns for as long as it stays away; the forfeit ends it', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(1000), 0)
		clocks = startPlayerPause(clocks, 'ann', 'away', SMALL, 10)
		clocks = catchUpClocks(clocks, 500)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 1000,
			hold: { kind: 'held for player', sinceAt: 10 },
		})
		expect(clocks.players.ann.awayLeftMilliseconds).toBe(0)
	})
})

describe('away_forfeit_moment', () => {
	const limits: PvpLimits = { ...SMALL, awayBudgetMilliseconds: 300 }
	it('a spent budget ends at the drop plus the budget, started pause or not', () => {
		const started = startPlayerPause(
			newClocks(PLAYERS, SMALL, 0),
			'ann',
			'away',
			SMALL,
			10,
		)
		expect(awayForfeitAt(catchUpClocks(started, 60), 'ann', 10)).toBe(110)
	})

	it('a server restart pause holds the countdowns and spends no away time', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(1000), 0)
		clocks = startPlayerPause(clocks, 'ann', 'server restart', SMALL, 10)
		clocks = catchUpClocks(clocks, 900)
		expect(clocks.players.ann.awayLeftMilliseconds).toBe(
			SMALL.awayBudgetMilliseconds,
		)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 1000,
			hold: { kind: 'held for player', sinceAt: 10 },
		})
	})

	it('an away player is charged with no countdown running', () => {
		const clocks = catchUpClocks(
			startPlayerPause(
				newClocks(PLAYERS, limits, 0),
				'ann',
				'away',
				limits,
				20,
			),
			100,
		)
		expect(clocks.players.ann.awayLeftMilliseconds).toBe(220)
		expect(awayForfeitAt(clocks, 'ann', 20)).toBe(320)
	})

	it('the budget left after a first drop moves the moment of the second', () => {
		let clocks = newClocks(PLAYERS, limits, 0)
		clocks = startPlayerPause(clocks, 'ann', 'away', limits, 10)
		clocks = endPlayerPause(clocks, 'ann', 'away', 170)
		expect(awayForfeitAt(clocks, 'ann', 500)).toBe(500 + 140)
		clocks = startPlayerPause(clocks, 'ann', 'away', limits, 500)
		expect(awayForfeitAt(catchUpClocks(clocks, 530), 'ann', 500)).toBe(640)
	})

	it('a player with no clock has no moment', () => {
		expect(awayForfeitAt(newClocks(PLAYERS, limits, 0), 'zed', 5)).toBeNull()
	})

	it('equals the cumulative away time reaching the budget, over any drops', () => {
		const drops = fc.array(
			fc.record({
				gap: fc.nat({ max: 400 }),
				away: fc.integer({ min: 1, max: 400 }),
			}),
			{ maxLength: 8 },
		)
		fc.assert(
			fc.property(drops, (list) => {
				let clocks = newClocks(PLAYERS, limits, 0)
				let now = 0
				let spent = 0
				for (const drop of list) {
					if (spent >= limits.awayBudgetMilliseconds) break
					now += drop.gap
					const since = now
					clocks = startPlayerPause(clocks, 'ann', 'away', limits, now)
					const moment = awayForfeitAt(clocks, 'ann', since)
					expect(moment).toBe(since + limits.awayBudgetMilliseconds - spent)
					if (moment !== null && since + drop.away >= moment) break
					now += drop.away
					spent += drop.away
					clocks = endPlayerPause(clocks, 'ann', 'away', now)
				}
			}),
		)
	})
})

// Main: an animation holds only the countdowns running against the animating player, and
// never the default Ante timer; away holds every countdown.
describe('which countdowns a player pause holds', () => {
	it.each<
		[
			string,
			'ante' | 'pvp' | 'personal',
			string,
			PlayerPause['reason'],
			boolean,
		]
	>([
		['animating, own pvp countdown', 'pvp', 'ann', 'animating', true],
		['animating, own personal countdown', 'personal', 'ann', 'animating', true],
		[
			'animating, the opponent runs out against me: not held',
			'pvp',
			'bob',
			'animating',
			false,
		],
		[
			'animating, the Ante timer against me keeps counting',
			'ante',
			'ann',
			'animating',
			false,
		],
		['away, the Ante timer is held', 'ante', 'ann', 'away', true],
		[
			'away, a countdown on the other player is held',
			'pvp',
			'bob',
			'away',
			true,
		],
	])('%s', (_name, kind, against, reason, held) => {
		let clocks = newClocks(PLAYERS, LIMITS, 0)
		clocks = startCountdown(
			clocks,
			kind === 'ante'
				? { ...ante(5000), against: [against] }
				: { kind, by: null, against: [against], lengthMilliseconds: 5000 },
			0,
		)
		clocks = startPlayerPause(clocks, 'ann', reason, LIMITS, 0)
		const later = catchUpClocks(clocks, 400)
		expect(timeLeft(later.countdowns[0], 400)).toBe(held ? 5000 : 4600)
	})
})

describe('an animating pause is charged only while it pauses a countdown', () => {
	const setups: [string, (clocks: Clocks) => Clocks][] = [
		['no countdown', (clocks) => clocks],
		[
			'only a countdown paused by its own player',
			(clocks) => pauseCountdowns(startCountdown(clocks, ante(500), 0), all, 0),
		],
		[
			'only the Ante timer, which an animation never holds',
			(clocks) => startCountdown(clocks, ante(500), 0),
		],
	]
	it.each(setups)('%s costs nothing', (_name, setup) => {
		const clocks = catchUpClocks(
			startPlayerPause(
				setup(newClocks(PLAYERS, SMALL, 0)),
				'ann',
				'animating',
				SMALL,
				0,
			),
			80,
		)
		expect(clocks.players.ann.animatingBlindLeftMilliseconds).toBe(
			SMALL.animatingBlindMilliseconds,
		)
	})

	it('a countdown started during an away stop starts paused; the stop was charged from its start', () => {
		let clocks = startPlayerPause(
			newClocks(PLAYERS, SMALL, 0),
			'ann',
			'away',
			SMALL,
			0,
		)
		clocks = startCountdown(clocks, ante(500), 50)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 550,
			hold: { kind: 'held for player', sinceAt: 50 },
		})
		clocks = catchUpClocks(clocks, 70)
		expect(clocks.players.ann.awayLeftMilliseconds).toBe(30)
	})

	it('a countdown paused by its own player during a pause stays paused when the pause ends', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(500), 0)
		clocks = startPlayerPause(clocks, 'ann', 'away', SMALL, 10)
		clocks = pauseCountdowns(clocks, all, 20)
		expect(clocks.countdowns[0]).toMatchObject({
			hold: { kind: 'paused by starter', sinceAt: 10 },
		})
		clocks = endPlayerPause(clocks, 'ann', 'away', 40)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 500,
			hold: { kind: 'paused by starter', sinceAt: 10 },
		})
	})

	it('ending a stop does not resume a countdown its player paused', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(500), 0)
		clocks = pauseCountdowns(clocks, all, 10)
		clocks = endPlayerPause(
			startPlayerPause(clocks, 'ann', 'away', SMALL, 20),
			'ann',
			'away',
			40,
		)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 500,
			hold: { kind: 'paused by starter', sinceAt: 10 },
		})
		clocks = resumeCountdowns(clocks, all, 100)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 590,
			hold: { kind: 'counting' },
		})
	})

	it('a resume during a stop keeps the countdown paused until the stop ends', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(500), 0)
		clocks = pauseCountdowns(clocks, all, 10)
		clocks = startPlayerPause(clocks, 'ann', 'away', SMALL, 20)
		clocks = resumeCountdowns(clocks, all, 30)
		expect(clocks.countdowns[0]).toMatchObject({
			hold: { kind: 'held for player', sinceAt: 10 },
		})
		clocks = endPlayerPause(clocks, 'ann', 'away', 60)
		expect(clocks.countdowns[0]).toMatchObject({
			endsAt: 550,
			hold: { kind: 'counting' },
		})
	})
})

describe('limits_come_from_rules', () => {
	it('an away stop holds the countdowns past its budget, whatever the limit is', () => {
		fc.assert(
			fc.property(
				fc.nat({ max: 5000 }),
				fc.integer({ min: 1, max: 9000 }),
				(budget, length) => {
					const limits = { ...SMALL, awayBudgetMilliseconds: budget }
					let clocks = startCountdown(
						newClocks(PLAYERS, limits, 0),
						ante(length),
						0,
					)
					clocks = catchUpClocks(
						startPlayerPause(clocks, 'ann', 'away', limits, 0),
						budget + 1000,
					)
					expect(clocks.countdowns[0].endsAt).toBe(length)
					expect(stoppedAt(clocks.countdowns[0])).toBe(0)
					expect(awayForfeitAt(clocks, 'ann', 0)).toBe(budget + 1000)
				},
			),
		)
	})

	it.each<[string, number, number, number]>([
		// name, hold limit, PvP blind limit, longest pause
		['the hold limit is the shorter', 30, 100, 30],
		['the PvP blind limit is the shorter', 100, 45, 45],
		['both equal', 50, 50, 50],
	])('an animating hold: %s', (_name, hold, currentPvpBlind, longest) => {
		const limits = {
			...SMALL,
			animatingHoldMilliseconds: hold,
			animatingBlindMilliseconds: currentPvpBlind,
		}
		let clocks = startCountdown(newClocks(PLAYERS, limits, 0), pvp(1000), 0)
		clocks = catchUpClocks(
			startPlayerPause(clocks, 'ann', 'animating', limits, 0),
			500,
		)
		expect(clocks.countdowns[0].endsAt).toBe(1000 + longest)
	})

	it('all holds of a PvP blind share the PvP blind budget', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), pvp(1000), 0)
		clocks = startPlayerPause(clocks, 'ann', 'animating', SMALL, 0)
		clocks = endPlayerPause(clocks, 'ann', 'animating', 20)
		clocks = catchUpClocks(
			startPlayerPause(clocks, 'ann', 'animating', SMALL, 40),
			200,
		)
		expect(clocks.countdowns[0].endsAt).toBe(1050)
		expect(clocks.players.ann.animatingBlindLeftMilliseconds).toBe(10)
		clocks = catchUpClocks(
			startPlayerPause(
				endPlayerPause(clocks, 'ann', 'animating', 200),
				'ann',
				'animating',
				SMALL,
				300,
			),
			400,
		)
		expect(clocks.countdowns[0].endsAt).toBe(1060)
	})

	it('two states that differ only in the limits behave differently', () => {
		const run = (away: number) =>
			catchUpClocks(
				startPlayerPause(
					startCountdown(
						newClocks(PLAYERS, { ...SMALL, awayBudgetMilliseconds: away }, 0),
						ante(500),
						0,
					),
					'ann',
					'away',
					{ ...SMALL, awayBudgetMilliseconds: away },
					0,
				),
				5,
			)
		expect(awayForfeitAt(run(10), 'ann', 0)).toBe(10)
		expect(awayForfeitAt(run(90), 'ann', 0)).toBe(90)
	})

	it('the limits are the ones the run was frozen with', () => {
		expect(frozenRules(PLAYERS, SMALL).limits).toEqual(SMALL)
		const state = runState(PLAYERS, SMALL)
		expect(state.run?.clocks.players.ann.awayLeftMilliseconds).toBe(
			SMALL.awayBudgetMilliseconds,
		)
	})
})

describe('clock laws', () => {
	it('advancing in two steps equals advancing in one', () => {
		fc.assert(
			fc.property(
				ops,
				fc.nat({ max: 300 }),
				fc.nat({ max: 300 }),
				(list, first, second) => {
					const { clocks, now } = play(list)
					expect(
						catchUpClocks(
							catchUpClocks(clocks, now + first),
							now + first + second,
						),
					).toEqual(catchUpClocks(clocks, now + first + second))
				},
			),
		)
	})

	it('budgets never go below 0, and a countdown paused for a player is paused', () => {
		fc.assert(
			fc.property(ops, fc.nat({ max: 300 }), (list, more) => {
				const { clocks, now } = play(list)
				const later = catchUpClocks(clocks, now + more)
				for (const entry of Object.values(later.players)) {
					expect(entry.awayLeftMilliseconds).toBeGreaterThanOrEqual(0)
					expect(entry.animatingBlindLeftMilliseconds).toBeGreaterThanOrEqual(0)
				}
				for (const stop of later.playerPauses)
					if (stop.reason === 'animating')
						expect(stop.holdLeftMilliseconds).toBeGreaterThanOrEqual(0)
				for (const countdown of later.countdowns) {
					if (countdown.hold.kind === 'held for player')
						expect(stoppedAt(countdown)).not.toBeNull()
				}
			}),
		)
	})

	it('time never goes back: advancing to an earlier time changes nothing', () => {
		fc.assert(
			fc.property(ops, fc.nat({ max: 300 }), (list, back) => {
				const { clocks, now } = play(list)
				expect(catchUpClocks(clocks, Math.max(0, now - back - 1))).toEqual(
					clocks,
				)
			}),
		)
	})
})

describe('countdownsAtZero', () => {
	it('lists the running countdowns that ended, earliest first, in start order on a tie', () => {
		let clocks = newClocks(PLAYERS, SMALL, 0)
		for (const length of [50, 20, 50, 90])
			clocks = startCountdown(clocks, { ...ante(length), kind: 'pvp' }, 0)
		const ended = countdownsAtZero(clocks, 60)
		expect(ended.map((countdown) => countdown.endsAt)).toEqual([20, 50, 50])
	})

	it('does not list a paused countdown, whatever its end time', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(10), 0)
		clocks = pauseCountdowns(clocks, all, 5)
		expect(countdownsAtZero(clocks, 1000)).toEqual([])
	})

	it('lists a countdown that ends exactly now, and not one that ends a millisecond later', () => {
		const clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(50), 0)
		expect(countdownsAtZero(clocks, 50)).toHaveLength(1)
		expect(countdownsAtZero(clocks, 49)).toEqual([])
	})

	it('removeCountdowns drops the matching ones only', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(10), 0)
		clocks = startCountdown(clocks, { ...ante(20), kind: 'pvp' }, 0)
		expect(
			removeCountdowns(clocks, (c) => c.kind === 'ante', 0).countdowns.map(
				(c) => c.kind,
			),
		).toEqual(['pvp'])
	})

	it('removeCountdowns first charges the pause up to now', () => {
		let clocks = startCountdown(newClocks(PLAYERS, SMALL, 0), ante(1000), 0)
		clocks = startPlayerPause(clocks, 'ann', 'away', SMALL, 0)
		clocks = removeCountdowns(clocks, all, 40)
		expect(clocks.players.ann.awayLeftMilliseconds).toBe(60)
		expect(clocks.settledAt).toBe(40)
	})
})

describe('a player outside the clocks', () => {
	it('is a bug in the caller, not an input', () => {
		expect(() =>
			startPlayerPause(newClocks(PLAYERS, SMALL, 0), 'zed', 'away', SMALL, 0),
		).toThrow()
	})
})

// Every optional field and every null filled in, so that a new field in the state type
// fails the typecheck here until it is added to the fixture below.
type Filled<T> = T extends readonly (infer Item)[]
	? Filled<Item>[]
	: T extends object
		? { [Key in keyof T]-?: Filled<NonNullable<T[Key]>> }
		: NonNullable<T>
type FilledState = Filled<Omit<State, 'run'>> & {
	run: Omit<Filled<NonNullable<State['run']>>, 'rules'> & {
		rules: ReturnType<typeof frozenRules>
	}
}

const FILLED: FilledState = {
	lobbyMode: 'teams',
	players: {
		ann: { team: 'A' },
		bob: { team: 'B' },
	},
	run: {
		id: 'run-1',
		rules: frozenRules(PLAYERS),
		players: {
			ann: {
				inbox: [
					{
						itemNumber: 1,
						from: 'bob',
						effect: 'trapReward',
						amount: 2,
						trap: { id: 7, key: 'snare', data: { size: 3 } },
					},
				],
				inboxDone: 1,
				totals: { skip: 2 },
				ante: 3,
				location: 'shop',
				sells: { '2': 1 },
				shopSpends: { '1': 5 },
				results: { '2:Small': { result: 'beaten' } },
				vouchers: ['v_hieroglyph'],
			},
			bob: {
				inbox: [],
				inboxDone: 0,
				totals: {},
				ante: 2,
				location: 'blind_select',
				sells: {},
				shopSpends: {},
				results: {},
				vouchers: [],
			},
		},
		clocks: {
			countdowns: [
				{
					kind: 'ante',
					by: 'bob',
					against: ['ann'],
					endsAt: 9000,
					hold: { kind: 'held for player', sinceAt: 4000 },
					blindKey: '1:Boss',
				},
				{
					kind: 'personal',
					rate: 1,
					by: 'bob',
					against: ['bob'],
					endsAt: 7000,
					hold: { kind: 'paused by starter', sinceAt: 1000 },
				},
			],
			playerPauses: [
				{ player: 'ann', reason: 'away' },
				{ player: 'bob', reason: 'animating', holdLeftMilliseconds: 300 },
			],
			players: {
				ann: {
					awayLeftMilliseconds: 500,
					animatingBlindLeftMilliseconds: 600,
				},
				bob: {
					awayLeftMilliseconds: 700,
					animatingBlindLeftMilliseconds: 800,
				},
			},
			settledAt: 4500,
		},
		ready: { cat: '2:Boss' },
		firstReady: ['cat'],
		currentPvpBlind: {
			blindKey: '2:Boss',
			players: {
				ann: { stage: 'done', endedBy: 'hands', handsLeft: 2, score: '10' },
				bob: { stage: 'done', endedBy: 'timer', handsLeft: 1, score: '5' },
			},
			banks: {},
		},
		finishedPvpBlinds: [
			{
				blindKey: '2:Boss',
				scores: { ann: '10', bob: '5' },
				endedBy: { ann: 'hands', bob: 'timer' },
				losers: ['bob'],
				livesAfter: { ann: 4, bob: 3 },
				teamScores: { A: '10', B: '5' },
			},
		],
		lives: {
			ann: {
				lives: 4,
				status: 'playing',
				events: [{ delta: -1, cause: 'pvp:1' }],
			},
			bob: {
				lives: 3,
				status: 'playing',
				events: [],
			},
		},
		teamLives: { A: 4, B: 3 },
		waitingDeaths: [
			{ playerId: 'bob', blindKey: '2:Boss', waitingFor: ['ann'] },
		],
		exits: [{ player: 'bob', blindKey: '2:Boss', batch: 1 }],
		lifeLedger: {
			lifeTakenFor: { bob: ['2:Boss'] },
			runOutsForgiven: { bob: 1 },
		},
		pairings: {
			3: {
				ante: 3,
				partners: { ann: 'bob', bob: 'ann' },
				usedPairs: ['ann|bob'],
				lastBye: 'ann',
			},
		},
		cardTargets: { ante: 3, targets: { ann: 'bob', bob: 'ann' } },
		teams: { ann: 'A', bob: 'B' },
		skips: {
			ann: { skips: 2, skipsAtPvp: 0, facing: 'bob', spentMilliseconds: 0 },
		},
		traps: [
			{
				id: 1,
				key: 'c_mp_trap_snare',
				owner: 'ann',
				holder: 'bob',
				state: 'live',
			},
		],
		votes: { draw: ['ann'], seed: ['bob'] },
		places: { ann: 1, bob: 2 },
		lastJokers: { bob: 'j_joker' },
		endGames: {
			ann: {
				jokers: 'j_joker',
				deck: 'b_red',
				stats: { rerollCount: 1, rerollCostTotal: 5 },
			},
		},
	},
	result: { kind: 'win', winners: ['ann'], rating: 'rated' },
}

function checkShift(
	before: unknown,
	after: unknown,
	key: string,
	downtime: number,
	moved: { count: number },
): void {
	if (typeof before === 'number') {
		const isTime = key.endsWith('At')
		expect(after).toBe(isTime ? before + downtime : before)
		if (isTime) moved.count += 1
	} else if (Array.isArray(before)) {
		expect(Array.isArray(after) && after.length === before.length).toBe(true)
		before.forEach((item, index) =>
			checkShift(item, (after as unknown[])[index], key, downtime, moved),
		)
	} else if (typeof before === 'object' && before !== null) {
		const afterFields = after as { [field: string]: unknown }
		expect(Object.keys(afterFields).sort()).toEqual(Object.keys(before).sort())
		for (const [field, value] of Object.entries(before))
			checkShift(value, afterFields[field], field, downtime, moved)
	} else {
		expect(after).toEqual(before)
	}
}

describe('shift_times_covers_every_time_field', () => {
	it('every number whose key ends in At moves by the downtime, and no other number moves', () => {
		fc.assert(
			fc.property(fc.nat({ max: 10_000_000 }), (downtime) => {
				const moved = { count: 0 }
				checkShift(
					FILLED,
					shiftTimes(FILLED, downtime),
					'state',
					downtime,
					moved,
				)
				expect(moved.count).toBeGreaterThanOrEqual(3)
			}),
		)
	})

	it('a counting countdown stays counting, and a match with no run is the same state', () => {
		const state = runState(PLAYERS)
		const running = startCountdown(
			state.run?.clocks ?? newClocks(PLAYERS, LIMITS, 0),
			ante(100),
			0,
		)
		expect(
			shiftTimes(inState(state, running), 50).run?.clocks.countdowns[0],
		).toMatchObject({ endsAt: 150, hold: { kind: 'counting' } })
		const none: State = {
			lobbyMode: 'royale',
			players: {},
			run: null,
			result: null,
		}
		expect(shiftTimes(none, 50)).toEqual(none)
	})

	it('settling after the downtime gives the same clocks as settling before it, shifted', () => {
		fc.assert(
			fc.property(
				ops,
				fc.nat({ max: 300 }),
				fc.nat({ max: 100_000 }),
				(list, more, downtime) => {
					const { clocks, now } = play(list)
					const state = inState(runState(PLAYERS, SMALL), clocks)
					const after = catchUpClocks(
						shiftTimes(state, downtime).run?.clocks ?? clocks,
						now + more + downtime,
					)
					const expected = shiftTimes(
						inState(state, catchUpClocks(clocks, now + more)),
						downtime,
					)
					expect(after).toEqual(expected.run?.clocks)
				},
			),
		)
	})
})
