import { describe, expect, it } from 'vitest'
import type { Lobby } from '../../state'
import type { State, Team } from '../core/types'
import type { PvpMode } from '../rules/settings'
import { runOf } from '../testing/inputs'
import {
	ANN_BOB,
	CONFIG,
	type LobbyParts,
	NOW,
	draft,
	lobbyOf,
	matchOf,
	started,
	vote,
} from '../testing/lobbies'
import { LIMITS } from '../testing/state'
import { nextStep, planOf, setupDone, startPvpRun } from './pvp_start'

// ---- Setup ----

describe('setupDone', () => {
	const rolled = (option: string) => ({ ruleset: vote(option) })
	it.each([
		[
			'private lobby: nothing to run',
			planOf('private', 'pvp_nemesis', 2),
			{},
			true,
		],
		[
			'ranked 2-player nemesis needs the draft',
			planOf('ranked', 'pvp_nemesis', 2),
			{},
			false,
		],
		[
			'ranked 2-player nemesis, draft done',
			planOf('ranked', 'pvp_nemesis', 2),
			{ draft },
			true,
		],
		['ranked has no vote', planOf('ranked', 'pvp_nemesis', 2), { draft }, true],
		[
			'a schedule draft needs exactly 2 players',
			planOf('casual', 'pvp_smallworld', 3),
			{},
			true,
		],
		[
			'a rotation draft fits 3',
			planOf('casual', 'pvp_royale', 3),
			rolled('vanilla'),
			false,
		],
		[
			'a rotation draft fits 2',
			planOf('casual', 'pvp_royale', 2),
			rolled('vanilla'),
			false,
		],
		[
			'a rotation draft does not fit 1',
			planOf('casual', 'pvp_royale', 1),
			rolled('vanilla'),
			true,
		],
		[
			'casual: the ruleset vote comes first',
			planOf('casual', 'pvp_manhunt', 3),
			{},
			false,
		],
		[
			'casual: vanilla needs no traps vote',
			planOf('casual', 'pvp_experimental', 2),
			{},
			true,
		],
		[
			'casual royale, vote and draft done',
			planOf('casual', 'pvp_royale', 3),
			{ ...rolled('vanilla'), draft },
			true,
		],
		[
			'balanced asks the traps vote',
			planOf('casual', 'pvp_teams', 4),
			{ ...rolled('balanced'), draft },
			false,
		],
		[
			'balanced, traps voted',
			planOf('casual', 'pvp_teams', 4),
			{ ...rolled('balanced'), traps: vote('on'), draft },
			true,
		],
		[
			'an unknown queue has no steps',
			planOf('casual', 'pvp_other', 2),
			{},
			true,
		],
		['a missing queue has no steps', planOf('ranked', undefined, 2), {}, true],
	] as const)('%s', (_, plan, results, expected) => {
		expect(setupDone(plan, results)).toBe(expected)
	})

	it('names the next step', () => {
		const plan = planOf('casual', 'pvp_royale', 3)
		expect(nextStep(plan, {})).toBe('ruleset')
		expect(nextStep(plan, { ruleset: vote('expanded') })).toBe('traps')
		expect(
			nextStep(plan, { ruleset: vote('expanded'), traps: vote('off') }),
		).toBe('draft')
		expect(nextStep(plan, { ruleset: draft })).toBe('ruleset')
	})
})

// ---- startPvpRun ----

describe('startPvpRun', () => {
	const ids3 = ['ann', 'bob', 'cat']
	const ids4 = ['ann', 'bob', 'cat', 'dee']
	it.each([
		['nemesis', { ranked: true, results: { draft } }, 'nemesis', 4],
		[
			'royale',
			{
				casual: true,
				ids: ids3,
				metadata: { queue_mode: 'pvp_royale' },
				results: { ruleset: vote('vanilla'), draft },
			},
			'royale',
			4,
		],
		[
			'manhunt',
			{
				casual: true,
				ids: ids3,
				metadata: { queue_mode: 'pvp_manhunt', manhunt_hunter_lives: 5 },
				results: { ruleset: vote('vanilla'), draft },
			},
			'manhunt',
			5,
		],
		[
			'teams',
			{
				casual: true,
				ids: ids4,
				metadata: { queue_mode: 'pvp_teams' },
				results: { ruleset: vote('vanilla'), draft },
				teamPlan: [
					['ann', 'bob'],
					['cat', 'dee'],
				] as [string[], string[]],
			},
			'teams',
			4,
		],
		['private nemesis', {}, 'nemesis', 4],
	] as [string, LobbyParts, PvpMode, number][])(
		'%s: builds the run from the lobby',
		(_, parts, mode, otherLives) => {
			const lobby = matchOf(lobbyOf(parts))
			const result = startPvpRun(lobby, CONFIG, NOW)
			if (!result.ok) throw new Error(result.reject)
			const run = runOf(result.state)
			const ids = parts.ids ?? ANN_BOB
			expect(run.id).toBe('run-1')
			expect(run.rules.mode).toBe(mode)
			expect(run.rules.startedCount).toBe(ids.length)
			expect(run.rules.limits).toEqual(LIMITS)
			expect(Object.keys(run.players).sort()).toEqual([...ids].sort())
			expect(Object.keys(run.clocks.players).sort()).toEqual([...ids].sort())
			expect(run.clocks.settledAt).toBe(NOW)
			expect(run.currentPvpBlind).toBeNull()
			expect(result.state.result).toBeNull()
			if (mode === 'manhunt') {
				const lives = Object.values(run.lives)
					.map((seat) => seat.lives)
					.sort()
				expect(lives).toEqual([1, otherLives, otherLives])
				expect(
					Object.values(result.state.players)
						.map((p) => p.team)
						.sort(),
				).toEqual(['HUNTER', 'HUNTER', 'RUNNER'])
			} else {
				for (const seat of Object.values(run.lives))
					expect(seat.lives).toBe(otherLives)
			}
			if (mode === 'teams') {
				expect(run.teamLives).toEqual({ A: 4, B: 4 })
				expect(run.cardTargets).not.toBeNull()
				expect(
					new Set(Object.values(result.state.players).map((p) => p.team)),
				).toEqual(new Set<Team | null>(['A', 'B']))
			} else {
				expect(run.teamLives).toBeNull()
			}
		},
	)

	it('the same lobby builds the same run', () => {
		const lobby = matchOf(
			lobbyOf({
				casual: true,
				ids: ids4,
				metadata: { queue_mode: 'pvp_teams' },
				results: { ruleset: vote('vanilla'), draft },
				teamPlan: [
					['ann', 'bob'],
					['cat', 'dee'],
				],
			}),
		)
		expect(startPvpRun(lobby, CONFIG, NOW)).toEqual(
			startPvpRun(lobby, CONFIG, NOW),
		)
	})

	describe('what the run id decides', () => {
		const lobby = matchOf(
			lobbyOf({
				casual: true,
				ids: ids4,
				metadata: { queue_mode: 'pvp_teams' },
				results: { ruleset: vote('vanilla'), draft },
				teamPlan: [
					['ann', 'bob'],
					['cat', 'dee'],
				],
			}),
		)
		const drawnFor = (runId: string) => {
			const started = lobby.game.started
			if (started === null) throw new Error('the lobby has no game')
			const result = startPvpRun(
				{ ...lobby, game: { ...lobby.game, started: { ...started, runId } } },
				CONFIG,
				NOW,
			)
			if (!result.ok) throw new Error(result.reject)
			const run = runOf(result.state)
			return JSON.stringify({
				teams: result.state.players,
				pairings: run.pairings,
				cardTargets: run.cardTargets,
			})
		}
		const runIds = Array.from({ length: 12 }, (_, at) => `run-${at}`)

		it('the same run id draws the same pairing and card targets', () => {
			for (const runId of runIds) expect(drawnFor(runId)).toBe(drawnFor(runId))
		})

		it('another run id can draw another one', () => {
			expect(new Set(runIds.map(drawnFor)).size).toBeGreaterThan(1)
		})
	})

	it('locks the ranked rules over what the host wrote', () => {
		const lobby = matchOf(
			lobbyOf({
				ranked: true,
				results: { draft },
				metadata: { queue_mode: 'pvp_royale', starting_lives: 9 },
			}),
		)
		const run = runOf(
			(startPvpRun(lobby, CONFIG, NOW) as { state: State }).state,
		)
		expect(run.rules.mode).toBe('nemesis')
		expect(run.rules.startingLives).toBe(4)
		expect(Object.values(run.lives)[0].lives).toBe(4)
	})

	it('a ranked lobby plays its locked ruleset, whatever a ruleset vote says', () => {
		const plain = matchOf(lobbyOf({ ranked: true, results: { draft } }))
		const voted = matchOf(
			lobbyOf({
				ranked: true,
				results: { draft, ruleset: vote('speedlatro') },
			}),
		)
		const locked = runOf(
			(startPvpRun(plain, CONFIG, NOW) as { state: State }).state,
		)
		const run = runOf(
			(startPvpRun(voted, CONFIG, NOW) as { state: State }).state,
		)
		expect(locked.rules.clocks.pvp).toBeNull()
		expect(run.rules).toEqual(locked.rules)
	})

	it('the rolled ruleset replaces the one in the metadata', () => {
		const rules = { casual: true, results: { ruleset: vote('vanilla'), draft } }
		const bad = matchOf(
			lobbyOf({ ...rules, metadata: { ruleset: 'not_a_ruleset' } }),
		)
		expect(startPvpRun(bad, CONFIG, NOW).ok).toBe(true)
		const missing = matchOf(
			lobbyOf({
				casual: true,
				results: { draft },
				metadata: { ruleset: 'not_a_ruleset' },
			}),
		)
		expect(startPvpRun(missing, CONFIG, NOW)).toEqual({
			ok: false,
			reject: 'setup_not_done',
		})
	})

	it('freezes the limits the config has now', () => {
		const limits = { ...LIMITS, awayBudgetMilliseconds: 1234 }
		const result = startPvpRun(
			matchOf(lobbyOf()),
			{ ...CONFIG, pvpLimits: limits },
			NOW,
		)
		expect(runOf((result as { state: State }).state).rules.limits).toEqual(
			limits,
		)
	})

	it.each([
		['Setup not done', matchOf(lobbyOf({ ranked: true })), 'setup_not_done'],
		[
			'a rule the lobby lacks',
			matchOf(lobbyOf({ metadata: { starting_lives: undefined } })),
			'bad_rules',
		],
		[
			'a queue mode that is not PvP',
			matchOf(lobbyOf({ metadata: { queue_mode: 'other' } })),
			'bad_rules',
		],
		[
			'an unknown ranked mode',
			matchOf({
				...lobbyOf({ results: { draft } }),
				rankedMode: 'pvp_ranked_nope',
			}),
			'bad_rules',
		],
		[
			'no game',
			matchOf({ ...lobbyOf(), game: { ...lobbyOf().game, started: null } }),
			'no_game',
		],
		['no match', lobbyOf(), 'no_game'],
	] as [string, Lobby, string][])('refuses %s', (_, lobby, reject) => {
		expect(startPvpRun(lobby, CONFIG, NOW)).toEqual({ ok: false, reject })
	})

	it('teams already on the match are the teams of the run', () => {
		const lobby = matchOf(
			lobbyOf({
				casual: true,
				ids: ids4,
				metadata: { queue_mode: 'pvp_teams' },
				results: { ruleset: vote('vanilla'), draft },
			}),
			'teams',
		)
		const teams: { [id: string]: Team } = {
			ann: 'A',
			bob: 'B',
			cat: 'B',
			dee: 'A',
		}
		const pvp = lobby.game.pvp as State
		const given: Lobby = {
			...lobby,
			game: {
				...lobby.game,
				pvp: {
					...pvp,
					players: Object.fromEntries(
						ids4.map((id) => [id, { team: teams[id] }]),
					),
				},
			},
		}
		const result = startPvpRun(given, CONFIG, NOW)
		if (!result.ok) throw new Error(result.reject)
		expect(
			Object.fromEntries(
				Object.entries(result.state.players).map(([id, p]) => [id, p.team]),
			),
		).toEqual(teams)
	})

	it('refuses a second start', () => {
		const lobby = matchOf(lobbyOf())
		const again = { ...lobby, game: { ...lobby.game, pvp: started(lobby) } }
		expect(startPvpRun(again, CONFIG, NOW)).toEqual({
			ok: false,
			reject: 'run_started',
		})
	})
})
