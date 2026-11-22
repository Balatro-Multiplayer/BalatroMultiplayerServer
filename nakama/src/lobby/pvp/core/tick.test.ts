import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pvpBlindView } from '../inputs/pvp_blind'
import { timersView } from '../inputs/timer'
import type { PvpMode } from '../rules/settings'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import { pairedRun, reportedRunInMode as runInMode } from '../testing/state'
import { stoppedAt } from './clock'

import { pvpStarted, timersViewAtSettle } from '../testing/timers'
import { settleMatch, tick } from './tick'
import type { State, Team } from './types'

const FACTS = { ranked: true }
// Far past any countdown a PvP blind starts on its own.
const LONG = 180_000

interface Setup {
	players: string[]
	bye?: string
	teams: { [player: string]: Team }
}

// One whole PvP blind of each mode: everyone Ready, everyone posts a score, nobody plays on.
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

const startOf = (mode: PvpMode, { players, bye, teams }: Setup): State => {
	if (bye !== undefined) {
		const [first, second] = players.filter((player) => player !== bye)
		return pairedRun(players, { [first]: second, [second]: first, [bye]: null })
	}
	const base = runInMode(players, mode, teams)
	return mode === 'teams' && base.run !== null
		? { ...base, run: { ...base.run, teamLives: { A: 4, B: 4 } } }
		: base
}

const playing = (mode: PvpMode, setup: Setup): State => {
	const { players, bye } = setup
	let state = startOf(mode, setup)
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

const livesOf = (state: State): { [player: string]: number } =>
	Object.fromEntries(
		Object.entries(runOf(state).lives).map(([id, seat]) => [id, seat.lives]),
	)

const poolsOf = (state: State) => {
	const run = runOf(state)
	return {
		players: livesOf(state),
		pooled: run.teamLives === null ? null : run.teamLives.A + run.teamLives.B,
	}
}

// Every player still in the PvP blind reports their last hand with the score they have
// (a player who never started scores 0).
const finish = (state: State, now: number): State => {
	let next = state
	for (const [player, own] of Object.entries(
		runOf(state).currentPvpBlind?.players ?? {},
	)) {
		if (own.stage === 'done') continue
		const score = own.stage === 'not entered' ? '0' : own.score
		if (own.stage === 'not entered')
			next = send(
				next,
				player,
				{ kind: 'blindStart', blindKey: BLIND, handsLeft: 1, score },
				now,
			).state
		next = send(
			next,
			player,
			{ kind: 'handScored', blindKey: BLIND, handsLeft: 0, score },
			now,
		).state
	}
	return next
}

const viewsOf = (state: State) =>
	Object.keys(state.players).map((player) => ({
		timers: timersViewAtSettle(state, player),
		currentPvpBlind: pvpBlindView(state, player),
	}))

describe('a quiet tick', () => {
	const state = playing('nemesis', MODES[0][1])

	it('quiet_tick_view_identical: with nothing due the state is the same object', () => {
		for (const now of [0, 1, 1000, LONG - 1, LONG * 10]) {
			const ticked = tick(state, now, FACTS)
			expect(ticked).toBe(state)
			expect(viewsOf(ticked)).toEqual(viewsOf(state))
		}
	})

	it('a decided match is left alone', () => {
		const done: State = { ...state, result: { kind: 'agreed' } }
		expect(tick(done, LONG * 2, FACTS)).toBe(done)
	})

	it('a state with no run is left alone', () => {
		const none: State = { ...state, run: null }
		expect(tick(none, LONG, FACTS)).toBe(none)
	})
})

describe('what is due', () => {
	const state = playing('nemesis', MODES[0][1])

	it('a stale Ante timer is dropped with nothing run out', () => {
		const run = runOf(state)
		const stale: State = {
			...state,
			run: {
				...run,
				clocks: {
					...run.clocks,
					countdowns: [
						...run.clocks.countdowns,
						{
							kind: 'ante',
							blindKey: '1:Small',
							by: 'ann',
							against: ['bob'],
							endsAt: 1_000_000_000,
							hold: { kind: 'counting' },
						},
					],
				},
			},
		}
		const kinds = (next: State) =>
			runOf(next).clocks.countdowns.map((countdown) => countdown.kind)
		expect(kinds(stale)).toContain('ante')
		expect(kinds(tick(stale, 0, FACTS))).not.toContain('ante')
	})
})

describe.each(MODES)('full_blind_per_mode: %s', (mode, setup) => {
	it('no player reporting leaves the blind open however long the tick', () => {
		const state = playing(mode, setup)
		expect(tick(state, LONG * 10, FACTS)).toBe(state)
	})

	it('the last hands closing the blind make the losers pay one life each', () => {
		const state = playing(mode, setup)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		const before = poolsOf(state)
		const after = tick(finish(state, LONG), LONG, FACTS)
		const run = runOf(after)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds).toHaveLength(1)
		expect(run.finishedPvpBlinds[0].blindKey).toBe(BLIND)
		const losers = [...run.finishedPvpBlinds[0].losers].sort()
		expect(losers.length).toBeGreaterThan(0)
		const now = poolsOf(after)
		for (const player of Object.keys(before.players))
			expect(now.players[player]).toBe(
				before.players[player] - (losers.includes(player) ? 1 : 0),
			)
	})

	it('one waiting death holds through the tick, and closes when the others have answered', () => {
		let state = answerOn(oneLifeLeft(mode, setup), 'ann', false)
		const held = tick(state, 0, FACTS)
		expect(held.result).toBeNull()
		expect(runOf(held).waitingDeaths).toHaveLength(1)
		for (const player of setup.players.filter((other) => other !== 'ann'))
			state = answerOn(state, player, true)
		const closed = tick(state, 0, FACTS)
		expect(runOf(closed).waitingDeaths).toEqual([])
		const ends =
			mode === 'teams' || mode === 'manhunt' || setup.players.length === 2
		expect(closed.result !== null).toBe(ends)
	})

	it('a second tick at the same time changes nothing', () => {
		const once = tick(finish(playing(mode, setup), LONG), LONG, FACTS)
		expect(tick(once, LONG, FACTS)).toBe(once)
	})
})

describe('tick over any run of times', () => {
	const times = fc.array(fc.integer({ min: 0, max: LONG * 3 }), {
		maxLength: 6,
	})
	const modes = fc.constantFrom(...MODES)

	it('determinism: the same inputs and times give the same state', () => {
		fc.assert(
			fc.property(modes, times, ([mode, setup], steps) => {
				const run = (): State =>
					[...steps]
						.sort((a, b) => a - b)
						.reduce((next, now) => tick(next, now, FACTS), playing(mode, setup))
				expect(run()).toEqual(run())
			}),
		)
	})

	it('lives_change_only_through_rules: only a closed PvP blind takes lives, as the losers', () => {
		fc.assert(
			fc.property(modes, times, ([mode, setup], steps) => {
				let state = playing(mode, setup)
				for (const now of [...steps].sort((a, b) => a - b)) {
					const before = poolsOf(state)
					const finishedPvpBlinds = runOf(state).finishedPvpBlinds.length
					state = tick(state, now, FACTS)
					const after = runOf(state)
					if (after.finishedPvpBlinds.length === finishedPvpBlinds) {
						expect(poolsOf(state)).toEqual(before)
						continue
					}
					if (after.teamLives !== null) continue
					const lost = Object.keys(before.players).filter(
						(player) => livesOf(state)[player] < before.players[player],
					)
					expect(lost.sort()).toEqual(
						[...after.finishedPvpBlinds[finishedPvpBlinds].losers].sort(),
					)
				}
			}),
		)
	})

	it('tick twice at the same now changes nothing', () => {
		fc.assert(
			fc.property(modes, times, ([mode, setup], steps) => {
				let state = playing(mode, setup)
				for (const now of [...steps].sort((a, b) => a - b)) {
					state = tick(state, now, FACTS)
					expect(tick(state, now, FACTS)).toBe(state)
				}
			}),
		)
	})
})

describe('the match after an input or a tick', () => {
	const duel = (): State => {
		const base = runInMode(['ann', 'bob'], 'nemesis')
		const run = runOf(base)
		return {
			...base,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, lives: 1 } },
			},
		}
	}
	const answered = (): State => {
		const dying = send(duel(), 'ann', {
			kind: 'blindResult',
			blindKey: '1:Small',
			result: 'lost',
		}).state
		return send(dying, 'bob', {
			kind: 'blindResult',
			blindKey: '1:Small',
			result: 'beaten',
		}).state
	}

	it('the waiting death settles into a win for the opponent', () => {
		const after = settleMatch(answered(), FACTS)
		expect(after.result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'rated',
		})
	})

	it('the same match is unrated in an unranked lobby', () => {
		const after = tick(answered(), 0, { ranked: false })
		expect(after.result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'unrated',
		})
	})

	it('decides nothing while the death still waits', () => {
		const dying = send(duel(), 'ann', {
			kind: 'blindResult',
			blindKey: '1:Small',
			result: 'lost',
		}).state
		expect(tick(dying, 0, FACTS).result).toBeNull()
		expect(runOf(tick(dying, 0, FACTS)).waitingDeaths).toHaveLength(1)
	})
})

const answerOn = (
	state: State,
	player: string,
	beaten: boolean,
	blindKey = '1:Small',
): State =>
	send(state, player, {
		kind: 'blindResult',
		blindKey,
		result: beaten ? 'beaten' : 'lost',
	}).state

// ann has one life left, so failing a normal blind is a death that waits for the others.
const oneLifeLeft = (mode: PvpMode, setup: Setup): State => {
	const state = startOf(mode, setup)
	const run = runOf(state)
	if (run.teamLives !== null)
		return { ...state, run: { ...run, teamLives: { A: 1, B: 4 } } }
	return {
		...state,
		run: {
			...run,
			lives: { ...run.lives, ann: { ...run.lives.ann, lives: 1 } },
		},
	}
}

describe('a waiting death holds the match, in every mode', () => {
	// failers/beaters answer after ann has failed; `ends` is what the match is at that point.
	const DUEL: [PvpMode, Setup] = [
		'nemesis',
		{ players: ['ann', 'bob'], teams: {} },
	]
	const ROYALE: [PvpMode, Setup] = [
		'royale',
		{ players: ['ann', 'bob'], teams: {} },
	]
	const TEAMS = MODES[3]
	const MANHUNT = MODES[4]
	const scenarios: [
		string,
		[PvpMode, Setup],
		string[],
		string[],
		State['result'],
	][] = [
		[
			'duel',
			DUEL,
			['bob'],
			[],
			{ kind: 'win', winners: ['bob'], rating: 'rated' },
		],
		[
			'royale',
			ROYALE,
			['bob'],
			[],
			{ kind: 'win', winners: ['bob'], rating: 'rated' },
		],
		[
			'teams',
			TEAMS,
			['cat'],
			['dee'],
			{ kind: 'win', winners: ['cat', 'dee'], rating: 'rated' },
		],
		[
			'manhunt',
			MANHUNT,
			['bob'],
			['cat'],
			{ kind: 'win', winners: ['bob', 'cat'], rating: 'rated' },
		],
	]

	describe.each(scenarios)(
		'%s',
		(_name, [mode, setup], beaters, failers, won) => {
			const dying = (): State =>
				answerOn(oneLifeLeft(mode, setup), 'ann', false)

			it.each([
				['after the input', (state: State) => settleMatch(state, FACTS)],
				['after a tick', (state: State) => tick(state, 0, FACTS)],
			])('holds while the answers are missing (%s)', (_when, decide) => {
				const after = decide(dying())
				expect(after.result).toBeNull()
				expect(runOf(after).waitingDeaths).toHaveLength(1)
			})

			it('a beaten blind by the other side settles the death into their win', () => {
				let state = dying()
				for (const player of beaters) state = answerOn(state, player, true)
				for (const player of failers) state = answerOn(state, player, true)
				expect(settleMatch(state, FACTS).result).toEqual(won)
				expect(tick(state, 0, FACTS).result).toEqual(won)
			})
		},
	)

	it.each([
		['teams', MODES[3]],
		['manhunt', MODES[4]],
	] as [string, [PvpMode, Setup]][])(
		'%s: every member of the other side failing the blind is a draw',
		(_name, [mode, setup]) => {
			let state = answerOn(oneLifeLeft(mode, setup), 'ann', false)
			const others = setup.players.filter(
				(player) => player !== 'ann' && setup.teams[player] !== setup.teams.ann,
			)
			for (const player of others) state = answerOn(state, player, false)
			const after = tick(state, 0, FACTS)
			expect(after.result).toEqual({ kind: 'draw', rating: 'rated' })
			expect(settleMatch(state, FACTS).result).toEqual(after.result)
		},
	)
})

describe('a skip counts as beaten for a waiting death', () => {
	it('the opponent skipping the blind ends the match for them', () => {
		const dying = answerOn(
			oneLifeLeft('nemesis', { players: ['ann', 'bob'], teams: {} }),
			'ann',
			false,
		)
		expect(tick(dying, 0, FACTS).result).toBeNull()
		const skipped = send(dying, 'bob', {
			kind: 'skip',
			blindKey: '1:Small',
			total: 1,
		}).state
		expect(tick(skipped, 0, FACTS).result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'rated',
		})
	})
})

describe('one death waiting on nobody', () => {
	it('settles at once and does not hang the match', () => {
		const state = oneLifeLeft('nemesis', { players: ['ann', 'bob'], teams: {} })
		const run = runOf(state)
		const open: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, lives: 0 } },
				waitingDeaths: [
					{ playerId: 'ann', blindKey: '1:Small', waitingFor: [] },
				],
			},
		}
		const after = tick(open, 0, FACTS)
		expect(runOf(after).waitingDeaths).toEqual([])
		expect(after.result).not.toBeNull()
	})
})

describe('a last life with the lowest score in a Royale', () => {
	it('the lowest score goes out as an exit of its own, with no blind', () => {
		const setup: Setup = { players: ['ann', 'bob', 'cat'], teams: {} }
		const state = playing('royale', setup)
		const run = runOf(state)
		const lone: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, lives: 1 } },
			},
		}
		const after = tick(finish(lone, LONG), LONG, FACTS)
		expect(runOf(after).finishedPvpBlinds[0].losers).toEqual(['ann'])
		expect(runOf(after).exits).toEqual([
			{ player: 'ann', blindKey: null, batch: 1 },
		])
	})
})

describe('a PvP timer running out', () => {
	it('the PvP countdown ends the PvP blind for a player', () => {
		const timed = pvpStarted()
		const after = tick(timed, LONG, FACTS)
		expect(runOf(after).finishedPvpBlinds[0].endedBy.bob).toBe('timer')
	})
})

describe('a pressure countdown while the PvP blind plays', () => {
	const PRESSURE = 50_000
	const PAUSED_AT = 500
	const held = (): State => {
		const state = playing('nemesis', MODES[0][1])
		const run = runOf(state)
		return {
			...state,
			run: {
				...run,
				rules: {
					...run.rules,
					clocks: {
						...run.rules.clocks,
						personal: {
							kind: 'pressure',
							baseMilliseconds: PRESSURE,
							timedRate: 1,
							previewCostMilliseconds: 0,
						},
					},
				},
				clocks: {
					...run.clocks,
					countdowns: [
						...run.clocks.countdowns,
						{
							kind: 'personal',
							rate: 1,
							by: null,
							against: ['ann'],
							endsAt: 1000,
							hold: { kind: 'paused for pvp blind', sinceAt: PAUSED_AT },
						},
					],
				},
			},
		}
	}
	const personalOf = (state: State) =>
		runOf(state).clocks.countdowns.filter(
			(countdown) => countdown.kind === 'personal',
		)

	it('does not tick: it stays where it is, uncharged, and a quiet tick is the same object', () => {
		const state = held()
		const ticked = tick(state, 2000, FACTS)
		expect(ticked).toBe(state)
		expect(personalOf(ticked)[0].endsAt).toBe(1000)
	})

	it('goes on with the time it had when the blind ends', () => {
		const after = tick(finish(held(), LONG), LONG, FACTS)
		expect(runOf(after).currentPvpBlind).toBeNull()
		expect(personalOf(after)).toHaveLength(1)
		expect(personalOf(after)[0].hold).toEqual({ kind: 'counting' })
		expect(personalOf(after)[0].endsAt).toBe(1000 + (LONG - PAUSED_AT))
		expect(livesOf(after).ann).toBe(
			runOf(after).finishedPvpBlinds[0].losers.includes('ann') ? 3 : 4,
		)
	})

	it('is dropped for a player with no lives left when the blind ends', () => {
		const state = held()
		const run = runOf(state)
		const out: State = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, ann: { ...run.lives.ann, lives: 1 } },
			},
		}
		const after = tick(finish(out, LONG), LONG, FACTS)
		expect(livesOf(after).ann).toBe(0)
		expect(personalOf(after)).toEqual([])
	})
})
