import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ServerOp } from '../../protocol'
import type { Lobby } from '../../state'
import { awayForfeitAt, shiftTimes } from '../core/clock'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import {
	LIMITS,
	droppedAt,
	pairedRun,
	reportedRunInMode as runInMode,
	runState,
} from '../testing/state'

import { tick } from '../core/tick'
import type { MatchResult, MyView, State, Team } from '../core/types'
import { view } from '../core/view'
import { requiredPlayers } from '../rules/players'
import { scoreOf } from '../rules/pvp_blind_rules'
import type { PvpMode } from '../rules/settings'
import {
	ANN_BOB,
	CONFIG,
	NOW,
	draft,
	lobbyOf,
	matchOf,
	started,
} from '../testing/lobbies'
import { anteStarted, pvpStarted } from '../testing/timers'
import { type LastViewSent, viewsToSend } from './last_view_sent'
import {
	type InputFacts,
	type ShellFacts,
	ending,
	factsOf,
	handleMessage,
	inputFactsOf,
	joinState,
	pvpHooks,
	resumeState,
	shellTick,
} from './pvp_shell'
import { startPvpRun } from './pvp_start'

// ---- fixtures ----

const facts = (over: Partial<ShellFacts> = {}): ShellFacts => ({
	gameStarted: true,
	away: [],
	left: [],
	grace: null,
	messageNumbers: {},
	ranked: true,
	forfeited: [],
	awayFrom: droppedAt(over.away ?? []),
	...over,
})

const rankedFacts = (
	state: State,
	messageNumbers: InputFacts['messageNumbers'] = {},
): InputFacts => ({
	ranked: true,
	left: [],
	awayFrom: {},
	messageNumbers,
	sessions: Object.fromEntries(
		Object.keys(state.players).map((id) => [id, 's1']),
	),
})

const droppedSince = (
	players: string[],
	since: { [player: string]: number },
): ShellFacts['awayFrom'] =>
	Object.fromEntries(
		players.map((id) => [id, { since: since[id], reason: 'dropped' as const }]),
	)

// ---- the grace rows ----

describe('shellTick', () => {
	it('both_away_abandoned', () => {
		const after = shellTick(
			runState(ANN_BOB),
			1000,
			facts({ left: ANN_BOB, forfeited: ANN_BOB }),
		)
		expect(after.result).toEqual({ kind: 'abandoned' })
	})

	it('away_past_grace_forfeits', () => {
		const after = shellTick(
			runState(ANN_BOB),
			1000,
			facts({ left: ['bob'], forfeited: ['bob'] }),
		)
		expect(runOf(after).lives.bob.status).toBe('forfeited')
		expect(after.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
		const casual = shellTick(
			runState(ANN_BOB),
			1000,
			facts({ left: ['bob'], forfeited: ['bob'], ranked: false }),
		)
		expect(casual.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'unrated',
		})
	})

	it('ranked_absent_at_start_forfeits_rated', () => {
		const lobby = matchOf(
			lobbyOf({ ranked: true, results: { draft }, away: ['bob'] }),
		)
		const state = started(lobby)
		const now = shellTick(
			state,
			NOW,
			factsOf({ ...lobby, game: { ...lobby.game, pvp: state } }),
		)
		expect(now.result).toBeNull()
		expect(runOf(now).clocks.playerPauses).toEqual([
			{ player: 'bob', reason: 'away' },
		])
		const gone: Lobby = {
			...lobby,
			players: lobby.players.filter((p) => p.id !== 'bob'),
			forfeitedSeats: { bob: 'run-1' },
			game: { ...lobby.game, pvp: now },
		}
		const later = shellTick(now, NOW + 130_000, factsOf(gone))
		expect(later.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
	})

	it('grace_one_away_other_blips', () => {
		const budgetOf = (steps: [number, string[]][]): number => {
			let state = anteStarted()
			for (const [now, away] of steps)
				state = shellTick(
					state,
					now,
					facts({
						away,
						awayFrom: droppedSince(away, { bob: 1000, ann: 2000 }),
					}),
				)
			state = shellTick(state, 5000, facts())
			return runOf(state).clocks.players.bob.awayLeftMilliseconds
		}
		const steady = budgetOf([
			[1000, ['bob']],
			[2000, ['bob']],
			[3000, ['bob']],
			[5000, ['bob']],
		])
		const blips = budgetOf([
			[1000, ['bob']],
			[2000, ['bob', 'ann']],
			[3000, ['bob']],
			[5000, ['bob']],
		])
		expect(blips).toBe(steady)
		expect(steady).toBe(LIMITS.awayBudgetMilliseconds - 4000)
	})

	it('left_player_is_not_required', () => {
		const state = ['ann', 'bob', 'cat'].reduce(
			(current, id) => ready(current, id).state,
			runInMode(['ann', 'bob', 'cat'], 'royale', {}),
		)
		expect(requiredPlayers(runOf(state))).toContain('cat')
		const after = shellTick(
			state,
			1000,
			facts({ left: ['cat'], ranked: false }),
		)
		expect(runOf(after).lives.cat.status).toBe('left')
		expect(requiredPlayers(runOf(after))).not.toContain('cat')
		expect(requiredPlayers(runOf(after))).toContain('ann')
	})

	it('a gone player before the run: a ranked leave is abandoned, any other is agreed', () => {
		const none: State = {
			lobbyMode: 'nemesis',
			players: {
				ann: { team: null },
				bob: { team: null },
			},
			run: null,
			result: null,
		}
		expect(shellTick(none, 5, facts({ left: ['bob'] })).result).toEqual({
			kind: 'abandoned',
		})
		expect(
			shellTick(none, 5, facts({ left: ['bob'], ranked: false })).result,
		).toEqual({ kind: 'agreed' })
		expect(shellTick(none, 5, facts())).toBe(none)
	})

	it('a decided match is final', () => {
		const done: State = { ...runState(ANN_BOB), result: { kind: 'agreed' } }
		expect(shellTick(done, 5, facts({ left: ['bob'] }))).toBe(done)
		expect(shellTick(done, 5, facts({ away: ['bob'] }))).toBe(done)
		const before: State = { ...done, run: null }
		expect(shellTick(before, 5, facts({ left: ['bob'] }))).toBe(before)
	})

	it('a quiet tick returns the same state', () => {
		const state = pvpStarted()
		expect(shellTick(state, 2000, facts())).toBe(state)
	})

	it('a player who comes back ends their pause', () => {
		const dropped = facts({ away: ['bob'], awayFrom: droppedAt(['bob'], 1000) })
		const away = shellTick(anteStarted(), 1000, dropped)
		expect(runOf(away).clocks.playerPauses).toHaveLength(1)
		expect(shellTick(away, 1500, dropped)).toBe(away)
		const back = shellTick(away, 2000, facts())
		expect(runOf(back).clocks.playerPauses).toEqual([])
	})

	it('a player who is gone is not paused as away', () => {
		const state = runInMode(['ann', 'bob', 'cat'], 'royale', {})
		const after = shellTick(
			state,
			1000,
			facts({ away: ['cat'], left: ['cat'], ranked: false }),
		)
		expect(runOf(after).clocks.playerPauses).toEqual([])
	})

	it('shift_times_covers_every_time_field', () => {
		const state = anteStarted()
		const away = shellTick(state, 1000, facts({ away: ['bob'] }))
		expect(resumeState(away, 5000)).toEqual(shiftTimes(away, 5000))
		const before = runOf(away).clocks
		const after = runOf(resumeState(away, 5000)).clocks
		expect(after.settledAt).toBe(before.settledAt + 5000)
		expect(after.countdowns.map((c) => c.endsAt)).toEqual(
			before.countdowns.map((c) => c.endsAt + 5000),
		)
	})
})

// ---- inputs ----

describe('handleMessage', () => {
	const header = (
		state: State,
		player: string,
		body: { [key: string]: unknown },
	) => ({
		messageNumber: 1,
		inboxDone: 0,
		runId: state.run?.id ?? null,
		...body,
	})

	it('drops a message from a session that is not the current one, unread', () => {
		const state = pvpStarted()
		const poison = {
			get messageNumber(): number {
				throw new Error('read')
			},
		}
		for (const session of ['old', '', 's2'])
			expect(
				handleMessage(state, 'ann', session, poison, 1500, rankedFacts(state)),
			).toEqual({ state, refusals: [], lastNumber: 0 })
		expect(
			handleMessage(state, 'zed', 's1', {}, 1500, rankedFacts(state)).state,
		).toBe(state)
	})

	it('runs the timer first: a hand after the timer ended loses to the timer', () => {
		const state = pvpStarted()
		const countdown = runOf(state).clocks.countdowns.find(
			(c) => c.kind === 'pvp',
		)
		if (countdown === undefined) throw new Error('no pvp timer')
		const late = countdown.endsAt + 1
		const hand = header(state, 'bob', {
			kind: 'handScored',
			blindKey: BLIND,
			handsLeft: 3,
			score: '100',
		})
		const taken = handleMessage(
			state,
			'bob',
			's1',
			hand,
			late,
			rankedFacts(state),
		)
		expect(taken.lastNumber).toBe(1)
		const bob = runOf(taken.state).currentPvpBlind?.players.bob
		const timedOut = bob?.stage === 'done' && bob.endedBy === 'timer'
		expect(
			runOf(taken.state).finishedPvpBlinds.length + (timedOut ? 1 : 0),
		).toBeGreaterThan(0)
		const scores =
			runOf(taken.state).finishedPvpBlinds[0]?.scores.bob ??
			(bob ? scoreOf(bob) : null)
		expect(scores).not.toBe('100')
	})

	it('decides the match after the input', () => {
		const state = runState(ANN_BOB)
		const forfeit = header(state, 'bob', { kind: 'forfeit' })
		const taken = handleMessage(
			state,
			'bob',
			's1',
			forfeit,
			1000,
			rankedFacts(state),
		)
		expect(taken.state.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
	})

	describe('the result is the same whichever of the tick and an input comes first', () => {
		const withAway = (state: State, away: string[]): InputFacts => ({
			...rankedFacts(state),
			awayFrom: droppedAt(away, 150_100),
		})
		const nonsense = { nonsense: true }

		it('P1: the Ante ended at 150000, bob is away: bob loses the life either way', () => {
			const state = anteStarted()
			const start = runOf(state).lives.bob.lives
			const droppedAtTick = facts({
				away: ['bob'],
				awayFrom: droppedAt(['bob'], 150_100),
			})
			const tickFirst = shellTick(state, 150_100, droppedAtTick)
			const input = handleMessage(
				state,
				'ann',
				's1',
				nonsense,
				150_050,
				withAway(state, ['bob']),
			)
			const inputFirst = shellTick(input.state, 150_100, droppedAtTick)
			expect(runOf(tickFirst).lives.bob.lives).toBe(start - 1)
			expect(runOf(inputFirst).lives.bob.lives).toBe(start - 1)
		})

		it('property: a tick and a refused input at the same time give the same lives and result', () => {
			const state = anteStarted()
			fc.assert(
				fc.property(
					fc.subarray(ANN_BOB),
					fc.integer({ min: 0, max: 700_000 }),
					fc.integer({ min: 0, max: 700_000 }),
					(away, first, wait) => {
						const mid = handleMessage(
							state,
							'ann',
							's1',
							nonsense,
							first,
							withAway(state, away),
						).state
						const now = first + wait
						const ticked = shellTick(mid, now, facts({ away }))
						const input = handleMessage(
							mid,
							'ann',
							's1',
							nonsense,
							now,
							withAway(mid, away),
						).state
						expect(runOf(input).lives).toEqual(runOf(ticked).lives)
						expect(input.result).toEqual(ticked.result)
						expect(runOf(input).clocks).toEqual(runOf(ticked).clocks)
					},
				),
			)
		})
	})

	describe('an away budget that ran out never resumes the countdowns', () => {
		it('P2: away at 1000 with a 300000 budget, seen at 306000: the countdowns stay held', () => {
			const droppedAtStart = facts({
				away: ['bob'],
				awayFrom: droppedAt(['bob'], 1000),
			})
			const away = shellTick(anteStarted(), 1000, droppedAtStart)
			expect(
				runOf(away).clocks.countdowns.some(
					(c) => c.hold.kind === 'held for player',
				),
			).toBe(true)
			const later = shellTick(away, 306_000, droppedAtStart)
			const clocks = runOf(later).clocks
			expect(
				clocks.countdowns.some((c) => c.hold.kind === 'held for player'),
			).toBe(true)
			expect(awayForfeitAt(clocks, 'bob', 1000)).toBe(
				1000 + LIMITS.awayBudgetMilliseconds,
			)
		})
	})

	it('returns the refusals of the core', () => {
		const state = runState(ANN_BOB)
		const taken = handleMessage(
			state,
			'ann',
			's1',
			{ nonsense: true },
			1000,
			rankedFacts(state),
		)
		expect(taken.refusals).toEqual(['unreadable_header'])
	})
})

// ---- properties over a sequence of steps ----

type Step =
	| {
			type: 'input'
			who: string
			session: string
			body: unknown
			header: boolean
			wait: number
	  }
	| { type: 'tick'; wait: number; away: string[]; left: string[] }

const BODIES: { [field: string]: unknown }[] = [
	{ kind: 'ready', ready: true, blindKey: BLIND },
	{ kind: 'ready', ready: false, blindKey: BLIND },
	{ kind: 'blindStart', blindKey: BLIND, handsLeft: 4, score: '0' },
	{ kind: 'handScored', blindKey: BLIND, handsLeft: 3, score: '12' },
	{ kind: 'handPlayed', blindKey: BLIND, handsLeft: 2 },
	{ kind: 'timerStart', timer: 'ante' },
	{ kind: 'timerStart', timer: 'pvp' },
	{ kind: 'vote', topic: 'draw', yes: true },
	{ kind: 'applied' },
	{ kind: 'forfeit' },
	{ kind: 'nonsense' },
]

const steps: fc.Arbitrary<Step[]> = fc.array(
	fc.oneof(
		fc.record({
			type: fc.constant('input' as const),
			who: fc.constantFrom('ann', 'bob', 'zed'),
			session: fc.constantFrom('s1', 's1', 's1', 'old'),
			body: fc.oneof(fc.constantFrom(...BODIES), fc.anything()),
			header: fc.boolean(),
			wait: fc.nat({ max: 90_000 }),
		}),
		fc.record({
			type: fc.constant('tick' as const),
			wait: fc.nat({ max: 400_000 }),
			away: fc.subarray(ANN_BOB),
			left: fc.subarray(ANN_BOB, { maxLength: 1 }),
		}),
	),
	{ maxLength: 14 },
)

function play(
	list: Step[],
	each: (
		before: State,
		after: State,
		now: number,
		away: string[],
		left: string[],
	) => void,
): void {
	let state = pvpStarted()
	let now = 1000
	const numbers: { [player: string]: number } = {}
	for (const step of list) {
		now += step.wait
		const before = state
		let away: string[] = []
		let left: string[] = []
		if (step.type === 'tick') {
			away = step.away
			left = step.left
			state = shellTick(
				state,
				now,
				facts({ away, left, forfeited: left, ranked: true }),
			)
		} else {
			const known = state.players[step.who]
			const body =
				step.header &&
				known !== undefined &&
				typeof step.body === 'object' &&
				step.body !== null
					? {
							messageNumber: (numbers[step.who] ?? 0) + 1,
							inboxDone: 0,
							runId: state.run?.id ?? null,
							...step.body,
						}
					: step.body
			const taken = handleMessage(
				state,
				step.who,
				step.session,
				body,
				now,
				rankedFacts(state, numbers),
			)
			expect(taken.lastNumber).toBeGreaterThanOrEqual(numbers[step.who] ?? 0)
			numbers[step.who] = taken.lastNumber
			state = taken.state
		}
		each(before, state, now, away, left)
	}
}

describe('any sequence of inputs and ticks', () => {
	it('never throws, and no input number goes down', () => {
		fc.assert(fc.property(steps, (list) => play(list, () => {})))
	})

	it('the views sent are the views of the new state, for exactly the players whose view changed', () => {
		fc.assert(
			fc.property(steps, (list) => {
				let sent: LastViewSent = {}
				play(list, (_, after, now, away, left) => {
					const shown = facts({ away, left })
					const result = viewsToSend(sent, after, ANN_BOB, now, shown)
					const strip = (mine: MyView | null) =>
						mine === null ? null : { ...mine, serverTime: 0 }
					const changed = ANN_BOB.filter((id) => {
						const mine = view(after, id, now, shown)
						return (
							mine !== null &&
							JSON.stringify(strip(mine)) !==
								JSON.stringify(strip(sent[id] ?? null))
						)
					})
					expect(result.views.map((entry) => entry.player)).toEqual(changed)
					for (const entry of result.views)
						expect(entry.view).toEqual(view(after, entry.player, now, shown))
					for (const id of ANN_BOB)
						expect(strip(result.sent[id] ?? null)).toEqual(
							strip(view(after, id, now, shown)),
						)
					sent = result.sent
				})
			}),
		)
	})
})

describe('viewsToSend', () => {
	it('sends everyone a view at first, and nothing on a quiet tick', () => {
		const state = pvpStarted()
		const first = viewsToSend({}, state, ANN_BOB, 1000, facts())
		expect(first.views.map((entry) => entry.player)).toEqual(ANN_BOB)
		const quiet = viewsToSend(
			first.sent,
			shellTick(state, 2000, facts()),
			ANN_BOB,
			2000,
			facts(),
		)
		expect(quiet.views).toEqual([])
		expect(quiet.sent).toEqual(first.sent)
	})

	it('sends only the player whose view changed', () => {
		const state = pvpStarted()
		const first = viewsToSend({}, state, ANN_BOB, 1000, facts())
		const moved = send(
			state,
			'ann',
			{ kind: 'ready', ready: false, blindKey: BLIND },
			1100,
		).state
		const after = facts({ messageNumbers: { ann: 1 } })
		const next = viewsToSend(first.sent, moved, ANN_BOB, 1100, after)
		expect(next.views.map((entry) => entry.player)).toEqual(['ann'])
		for (const entry of next.views)
			expect(entry.view).toEqual(view(moved, entry.player, 1100, after))
	})

	it('a view with a field more or fewer than the one sent is a change', () => {
		const state = pvpStarted()
		const first = viewsToSend({}, state, ANN_BOB, 1000, facts())
		const mine = first.sent.ann
		const fewer = Object.fromEntries(
			Object.entries(mine).filter(([name]) => name !== 'match'),
		)
		const more = { ...mine, extra: 1 }
		for (const odd of [fewer, more])
			expect(
				viewsToSend(
					{ ...first.sent, ann: odd as unknown as typeof mine },
					state,
					ANN_BOB,
					1000,
					facts(),
				).views.map((entry) => entry.player),
			).toEqual(['ann'])
	})

	it('a player who is not in the match has no view', () => {
		expect(viewsToSend({}, pvpStarted(), ['zed'], 1000, facts()).views).toEqual(
			[],
		)
	})
})

// ---- the ending ----

describe('ending', () => {
	const places = { ann: 2, bob: 1, cat: 2 }
	const withResult = (result: MatchResult | null): State => {
		const state = runState(['ann', 'bob', 'cat'])
		return { ...state, run: { ...runOf(state), places }, result }
	}
	it.each([
		['no result', null, null],
		[
			'win',
			{ kind: 'win', winners: ['bob'], rating: 'rated' },
			{
				status: 'agreed',
				placements: [
					{ playerId: 'bob', place: 1 },
					{ playerId: 'ann', place: 2 },
					{ playerId: 'cat', place: 2 },
				],
			},
		],
		[
			'draw',
			{ kind: 'draw', rating: 'unrated' },
			{
				status: 'agreed',
				placements: [
					{ playerId: 'bob', place: 1 },
					{ playerId: 'ann', place: 2 },
					{ playerId: 'cat', place: 2 },
				],
			},
		],
		['agreed', { kind: 'agreed' }, { status: 'agreed', placements: [] }],
		[
			'abandoned',
			{ kind: 'abandoned' },
			{ status: 'abandoned', placements: [] },
		],
		[
			'contested',
			{ kind: 'contested' },
			{ status: 'contested', placements: [] },
		],
		[
			'restarted',
			{ kind: 'restarted' },
			{ status: 'restarted', placements: [] },
		],
	] as [string, MatchResult | null, unknown][])('%s', (_, result, expected) => {
		expect(ending(withResult(result))).toEqual(expected)
	})

	it('players on the same place are listed by name, whatever order the places were stored in', () => {
		const state = runState(['ann', 'bob', 'cat'])
		const tied: State = {
			...state,
			run: { ...runOf(state), places: { cat: 2, ann: 2, bob: 1 } },
			result: { kind: 'win', winners: ['bob'], rating: 'rated' },
		}
		expect(ending(tied)?.placements).toEqual([
			{ playerId: 'bob', place: 1 },
			{ playerId: 'ann', place: 2 },
			{ playerId: 'cat', place: 2 },
		])
	})

	it('a win before the run has no places', () => {
		const none: State = {
			lobbyMode: 'nemesis',
			players: {},
			run: null,
			result: { kind: 'win', winners: [], rating: 'rated' },
		}
		expect(ending(none)).toEqual({ status: 'agreed', placements: [] })
	})
})

// ---- joining ----

describe('joinState', () => {
	const withInbox = (): State => {
		const state = runState(ANN_BOB)
		const run = runOf(state)
		const inbox = [1, 2, 3].map((itemNumber) => ({
			itemNumber,
			from: null,
			effect: 'comebackBonus' as const,
			amount: 1,
		}))
		return {
			...state,
			run: {
				...run,
				players: {
					...run.players,
					ann: { ...run.players.ann, inbox, inboxDone: 2 },
				},
			},
		}
	}
	const lastOf = (state: State | { reject: string }): number | string =>
		'reject' in state ? state.reject : runOf(state).players.ann.inboxDone

	it.each([
		['both keys absent: none', {}, 0],
		[
			'this run, a whole number in range',
			{ pvp_run: 'run-1', pvp_inbox_done: 2 },
			2,
		],
		['this run, the whole inbox', { pvp_run: 'run-1', pvp_inbox_done: 3 }, 3],
		['this run, zero', { pvp_run: 'run-1', pvp_inbox_done: 0 }, 0],
		[
			'another run: none, not refused',
			{ pvp_run: 'run-0', pvp_inbox_done: 99 },
			0,
		],
		[
			'this run, above the inbox: refused',
			{ pvp_run: 'run-1', pvp_inbox_done: 4 },
			'bad_params',
		],
		['one key alone: refused', { pvp_run: 'run-1' }, 'bad_params'],
		['the other key alone: refused', { pvp_inbox_done: 1 }, 'bad_params'],
		[
			'not a whole number: refused',
			{ pvp_run: 'run-1', pvp_inbox_done: 1.5 },
			'bad_params',
		],
		[
			'negative: refused',
			{ pvp_run: 'run-1', pvp_inbox_done: -1 },
			'bad_params',
		],
		[
			'text number: refused',
			{ pvp_run: 'run-1', pvp_inbox_done: '1' },
			'bad_params',
		],
		['run not text: refused', { pvp_run: 1, pvp_inbox_done: 1 }, 'bad_params'],
	] as [string, { [key: string]: unknown }, number | string][])(
		'%s',
		(_, keys, expected) => {
			expect(lastOf(joinState(withInbox(), 'ann', keys))).toBe(expected)
		},
	)

	it('no run open: both keys are ignored', () => {
		const none: State = {
			lobbyMode: 'nemesis',
			players: {},
			run: null,
			result: null,
		}
		expect(joinState(none, 'ann', { pvp_run: 'x' })).toBe(none)
	})

	it('a player with no place in the run changes nothing', () => {
		const state = withInbox()
		expect(joinState(state, 'zed', { pvp_run: 'run-1' })).toBe(state)
	})
})

// ---- the hooks ----

describe('pvpHooks', () => {
	const asStep = (value: ReturnType<typeof pvpHooks.onStart>) => {
		if ('reject' in value) throw new Error(value.reject)
		return value
	}

	it('onStart: a private lobby starts its run at once', () => {
		const step = asStep(pvpHooks.onStart(lobbyOf(), CONFIG, NOW))
		expect(step.lobby.game.pvp?.run?.id).toBe('run-1')
		expect(step.out).toEqual([])
	})

	it('onStart: a ranked lobby waits for the draft, then startRunWhenSetupDone starts the run', () => {
		const waiting = asStep(
			pvpHooks.onStart(lobbyOf({ ranked: true }), CONFIG, NOW),
		)
		expect(waiting.lobby.game.pvp).toMatchObject({
			run: null,
			result: null,
			lobbyMode: 'nemesis',
		})
		expect(pvpHooks.startRunWhenSetupDone(waiting.lobby, CONFIG, NOW)).toEqual({
			lobby: waiting.lobby,
			out: [],
		})
		const done = {
			...waiting.lobby,
			game: {
				...waiting.lobby.game,
				setup: { open: null, results: { draft } },
			},
		}
		const step = asStep(pvpHooks.startRunWhenSetupDone(done, CONFIG, NOW + 5))
		expect(step.lobby.game.pvp?.run?.clocks.settledAt).toBe(NOW + 5)
		expect(pvpHooks.startRunWhenSetupDone(step.lobby, CONFIG, NOW + 6)).toEqual(
			{
				lobby: step.lobby,
				out: [],
			},
		)
	})

	it('onStart: a player below the minimum version refuses the game', () => {
		const config = { ...CONFIG, pvpMinVersion: '1.0.5' }
		expect(
			pvpHooks.onStart(lobbyOf({ version: '1.0.4' }), config, NOW),
		).toEqual({ reject: 'pvp_update_required' })
		expect(pvpHooks.onStart(lobbyOf({}), config, NOW)).toEqual({
			reject: 'pvp_update_required',
		})
		expect(
			'reject' in pvpHooks.onStart(lobbyOf({ version: '1.0.5' }), config, NOW),
		).toBe(false)
	})

	it('onStart: rules the run cannot use refuse the game', () => {
		const bad = lobbyOf({ metadata: { queue_mode: 'nope' } })
		expect(pvpHooks.onStart(bad, CONFIG, NOW)).toEqual({ reject: 'bad_rules' })
		expect(
			pvpHooks.onStart(
				lobbyOf({ metadata: { starting_lives: undefined } }),
				CONFIG,
				NOW,
			),
		).toEqual({ reject: 'bad_rules' })
	})

	it('onStart: a player already gone is handled at the start', () => {
		const lobby = {
			...lobbyOf(),
			players: lobbyOf().players.filter((p) => p.id === 'ann'),
		}
		const step = asStep(pvpHooks.onStart(lobby, CONFIG, NOW))
		expect(step.lobby.game.pvp?.result).toEqual({ kind: 'agreed' })
		expect(step.lobby.game.pvp?.run).toBeNull()
	})

	it('onStart: a ranked player already gone ends abandoned, never a rated win', () => {
		const ranked = lobbyOf({ ranked: true, results: { draft } })
		const lobby = {
			...ranked,
			players: ranked.players.filter((p) => p.id === 'ann'),
		}
		const step = asStep(pvpHooks.onStart(lobby, CONFIG, NOW))
		expect(step.lobby.game.pvp?.result).toEqual({ kind: 'abandoned' })
		expect(step.lobby.game.pvp?.run).toBeNull()
	})

	it('startRunWhenSetupDone: a ranked player who left while Setup was open ends abandoned', () => {
		const open = asStep(
			pvpHooks.onStart(lobbyOf({ ranked: true }), CONFIG, NOW),
		)
		expect(open.lobby.game.pvp?.run).toBeNull()
		const lobby = {
			...open.lobby,
			players: open.lobby.players.filter((p) => p.id === 'ann'),
		}
		const gone = asStep(pvpHooks.startRunWhenSetupDone(lobby, CONFIG, NOW + 5))
		expect(gone.lobby.game.pvp?.result).toEqual({ kind: 'abandoned' })
	})

	it('onRestart: builds a new match with the kept Setup results', () => {
		const lobby = lobbyOf({ ranked: true, results: { draft } })
		const old = asStep(pvpHooks.onStart(lobby, CONFIG, NOW))
		const restarted = {
			...old.lobby,
			game: {
				...old.lobby.game,
				pvp: {
					...(old.lobby.game.pvp as State),
					result: { kind: 'restarted' } as MatchResult,
				},
			},
		}
		const step = asStep(pvpHooks.onRestart(restarted, CONFIG, NOW + 9))
		expect(step.lobby.game.pvp?.result).toBeNull()
		expect(step.lobby.game.pvp?.run?.clocks.settledAt).toBe(NOW + 9)
		expect(
			pvpHooks.onRestart(
				lobbyOf({ metadata: { queue_mode: 'x' } }),
				CONFIG,
				NOW,
			),
		).toEqual({ reject: 'bad_rules' })
	})

	it('onJoin: sets the last item and sends nothing itself', () => {
		const step = asStep(pvpHooks.onStart(lobbyOf(), CONFIG, NOW))
		const joined = pvpHooks.onJoin(
			step.lobby,
			{ playerId: 'bob', joinKeys: {} },
			NOW + 1,
		)
		if ('reject' in joined) throw new Error(joined.reject)
		expect(joined.out).toEqual([])
		const shown = pvpHooks.views(joined.lobby, {}, NOW + 1)
		expect(shown.out).toContainEqual(
			expect.objectContaining({ op: ServerOp.VIEW, to: ['bob'] }),
		)
		const refused = pvpHooks.onJoin(
			step.lobby,
			{ playerId: 'bob', joinKeys: { pvp_run: 'run-1' } },
			NOW,
		)
		expect(refused).toEqual({ reject: 'bad_params' })
		expect(
			pvpHooks.onJoin(step.lobby, { playerId: 'zed', joinKeys: {} }, NOW),
		).toEqual({ lobby: step.lobby, out: [] })
		expect(
			pvpHooks.onJoin(lobbyOf(), { playerId: 'bob', joinKeys: {} }, NOW),
		).toEqual({ lobby: lobbyOf(), out: [] })
	})

	it('onResume shifts the match; ending reads the result', () => {
		const step = asStep(pvpHooks.onStart(lobbyOf(), CONFIG, NOW))
		const resumed = pvpHooks.onResume(step.lobby, 500)
		expect(resumed.game.pvp?.run?.clocks.settledAt).toBe(NOW + 500)
		expect(pvpHooks.onResume(lobbyOf(), 500)).toEqual(lobbyOf())
		expect(pvpHooks.ending(step.lobby, NOW)).toBeNull()
		expect(pvpHooks.ending(lobbyOf(), NOW)).toBeNull()
		const over = {
			...step.lobby,
			game: {
				...step.lobby.game,
				pvp: {
					...(step.lobby.game.pvp as State),
					result: { kind: 'agreed' } as MatchResult,
				},
			},
		}
		expect(pvpHooks.ending(over, NOW)).toEqual({
			status: 'agreed',
			placements: [],
		})
	})

	it('the facts of a lobby: away, left, forfeited, one grace deadline, sessions', () => {
		const lobby = matchOf(
			lobbyOf({ ids: ['ann', 'bob', 'cat'], away: ['bob', 'cat'] }),
		)
		const shown = factsOf({
			...lobby,
			players: lobby.players.slice(1),
			forfeitedSeats: { ann: 'run-1' },
		})
		expect(shown).toMatchObject({
			gameStarted: true,
			away: ['bob', 'cat'],
			left: ['ann'],
			forfeited: ['ann'],
			ranked: false,
		})
		expect(shown.grace).toEqual({ against: ['bob', 'cat'], endsAt: 125_000 })
		expect(factsOf(lobby).forfeited).toEqual([])
		expect(
			factsOf({
				...lobby,
				forfeitedSeats: { ann: 'run-0' },
				players: lobby.players.slice(1),
			}).forfeited,
		).toEqual([])
		expect(factsOf(lobbyOf()).grace).toBeNull()
		const staggered = lobbyOf({ ids: ['ann', 'bob', 'cat'] })
		const awayAt = (since: { [id: string]: number | null }): Lobby => ({
			...staggered,
			players: staggered.players.map((p) => ({
				...p,
				awaySince: since[p.id] ?? null,
			})),
		})
		expect(factsOf(awayAt({ ann: 7_000, bob: 3_000 })).grace).toEqual({
			against: ['bob'],
			endsAt: 3_000 + 120_000,
		})
		expect(factsOf(awayAt({ ann: 3_000, bob: 7_000 })).grace).toEqual({
			against: ['ann'],
			endsAt: 3_000 + 120_000,
		})
		expect(factsOf(awayAt({ ann: 3_000, bob: 3_000 })).grace).toEqual({
			against: ['ann', 'bob'],
			endsAt: 3_000 + 120_000,
		})
		expect(inputFactsOf(lobby)).toEqual({
			ranked: false,
			left: [],
			awayFrom: {
				bob: { since: 5_000, reason: 'dropped' },
				cat: { since: 5_000, reason: 'dropped' },
			},
			sessions: { ann: 'ann-s1', bob: 'bob-s1', cat: 'cat-s1' },
			messageNumbers: {},
		})
	})
})

// ---- the rows a whole blind of each mode has with the shell on top ----

interface Setup {
	players: string[]
	bye?: string
	teams: { [player: string]: Team }
}

const MODES: [PvpMode, Setup][] = [
	['nemesis', { players: ['ann', 'bob'], teams: {} }],
	['nemesis', { players: ['ann', 'bob', 'cat'], bye: 'cat', teams: {} }],
	['royale', { players: ['ann', 'bob', 'cat'], teams: {} }],
	[
		'teams',
		{
			players: ['ann', 'bob', 'cat', 'dee'],
			teams: { ann: 'A', bob: 'A', cat: 'B', dee: 'B' },
		},
	],
	[
		'manhunt',
		{
			players: ['ann', 'bob', 'cat'],
			teams: { ann: 'RUNNER', bob: 'HUNTER', cat: 'HUNTER' },
		},
	],
]

function playing(mode: PvpMode, { players, bye, teams }: Setup): State {
	let state: State
	if (bye !== undefined) {
		const [first, second] = players.filter((player) => player !== bye)
		state = pairedRun(players, {
			[first]: second,
			[second]: first,
			[bye]: null,
		})
	} else {
		state = runInMode(players, mode, teams)
		if (mode === 'teams' && state.run !== null)
			state = { ...state, run: { ...state.run, teamLives: { A: 4, B: 4 } } }
	}
	for (const player of players) state = ready(state, player, true).state
	players
		.filter((player) => player !== bye)
		.forEach((player, at) => {
			state = send(state, player, {
				kind: 'blindStart',
				blindKey: BLIND,
				handsLeft: 4,
				score: String((at + 1) * 10),
			}).state
		})
	return state
}

describe.each(MODES)('full_blind_per_mode (shell): %s', (mode, setup) => {
	const LONG = 180_000

	it('a quiet shell tick is the same state', () => {
		const state = playing(mode, setup)
		expect(shellTick(state, LONG - 1, facts())).toBe(state)
	})

	it('with nobody away or gone, the shell tick is the core tick', () => {
		const state = playing(mode, setup)
		expect(shellTick(state, LONG, facts())).toEqual(
			tick(state, LONG, { ranked: true }),
		)
	})

	it('a player who left is out of the run, the others play on', () => {
		const state = playing(mode, setup)
		const leaver = setup.players[setup.players.length - 1]
		const after = shellTick(
			state,
			1000,
			facts({ left: [leaver], ranked: false }),
		)
		expect(
			runOf(after).lives[leaver].status === 'left' || after.result !== null,
		).toBe(true)
		expect(
			shellTick(after, 1000, facts({ left: [leaver], ranked: false })),
		).toEqual(after)
	})

	it('everyone gone ends the match with no winner decided by the shell', () => {
		const state = playing(mode, setup)
		const after = shellTick(
			state,
			1000,
			facts({ left: setup.players, forfeited: setup.players }),
		)
		expect(after.result).not.toBeNull()
	})
})

describe('a player who comes back from away', () => {
	it('loses their first-Ready place with their Ready mark', () => {
		let state = ready(anteStarted(), 'bob').state
		expect(runOf(state).firstReady).toEqual(['ann'])
		state = shellTick(state, 1000, facts({ away: ['ann'] }))
		state = shellTick(state, 2000, facts())
		expect(runOf(state).firstReady).toEqual([])
	})
})
