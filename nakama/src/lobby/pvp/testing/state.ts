import { newClocks } from '../core/clock'
import type {
	AwayFrom,
	Milliseconds,
	PvpLimits,
	Run,
	RunRulesAndLimits,
	State,
	Team,
} from '../core/types'
// Test support for the core: literal states, with no plumbing.
import type { PvpMode } from '../rules/settings'
import { settingsAtStart, withRules } from './rules'

// Facts for players who dropped at `since`.
export const droppedAt = (
	players: string[],
	since: Milliseconds = 0,
): { [player: string]: AwayFrom } =>
	Object.fromEntries(
		players.map((id) => [id, { since, reason: 'dropped' as const }]),
	)

export const LIMITS: PvpLimits = {
	animatingHoldMilliseconds: 300_000,
	animatingBlindMilliseconds: 600_000,
	awayBudgetMilliseconds: 120_000,
}

export function frozenRules(
	startedIds: string[],
	limits: PvpLimits = LIMITS,
): RunRulesAndLimits {
	return {
		...settingsAtStart(withRules(), startedIds),
		limits,
	}
}

export function eachPlayer<Entry>(
	players: string[],
	make: () => Entry,
): { [player: string]: Entry } {
	const result: { [player: string]: Entry } = {}
	for (const player of players) result[player] = make()
	return result
}

// A match with a run: no player has sent an input, every inbox is empty, no totals, no countdowns.
export function runState(
	players: string[],
	limits: PvpLimits = LIMITS,
	now: Milliseconds = 0,
): State {
	const rules = frozenRules(players, limits)
	return {
		lobbyMode: rules.mode,
		players: eachPlayer(players, () => ({ team: null })),
		run: {
			id: 'run-1',
			rules,
			players: eachPlayer(players, () => ({
				inbox: [],
				inboxDone: 0,
				totals: {},
				ante: null,
				location: null,
				sells: {},
				shopSpends: {},
				results: {},
				vouchers: [],
			})),
			clocks: newClocks(players, limits, now),
			currentPvpBlind: null,
			ready: {},
			firstReady: [],
			finishedPvpBlinds: [],
			lives: eachPlayer(players, () => ({
				lives: 4,
				status: 'playing',
				events: [],
			})),
			teamLives: null,
			waitingDeaths: [],
			exits: [],
			lifeLedger: { lifeTakenFor: {}, runOutsForgiven: {} },
			pairings: {},
			skips: {},
			traps: [],
			cardTargets: null,
			teams: {},
			votes: { draw: [], seed: [] },
			places: {},
			endGames: {},
			lastJokers: {},
		},
		result: null,
	}
}

// The same run with every player having reported `ante`, as a run in play has.
export function reported(state: State, ante = 2): State {
	const run = state.run
	if (run === null) throw new Error('no run')
	const players: Run['players'] = {}
	for (const player of Object.keys(run.players))
		players[player] = { ...run.players[player], ante }
	return { ...state, run: { ...run, players } }
}

// A run of `mode` with the picked teams, for the rules that read them.
export function runInMode(
	players: string[],
	mode: PvpMode,
	teams: { [player: string]: Team } = {},
): State {
	const base = runState(players)
	if (base.run === null) throw new Error('no run')
	const picked: State['players'] = {}
	for (const player of players)
		picked[player] = { ...base.players[player], team: teams[player] ?? null }
	return {
		lobbyMode: mode,
		players: picked,
		run: { ...base.run, rules: { ...base.run.rules, mode }, teams },
		result: null,
	}
}

// The same runs with every player having reported their ante, as in a run in play.
export const reportedRunInMode = (...args: Parameters<typeof runInMode>) =>
	reported(runInMode(...args))
export const reportedRunState = (...args: Parameters<typeof runState>) =>
	reported(runState(...args))

// A run of Nemesis for `players` with the given pairing stored for `ante`: a partner of
// null is the bye. Every player has reported that ante.
export function pairedRun(
	players: string[],
	partners: { [player: string]: string | null },
	ante = 2,
): State {
	const base = runState(players)
	if (base.run === null) throw new Error('no run')
	const bye = Object.keys(partners).find((player) => partners[player] === null)
	const pairs = Object.keys(partners)
		.filter((player) => {
			const partner = partners[player]
			return partner !== null && player < partner
		})
		.map((player) => `${player}|${partners[player]}`)
	return {
		...base,
		run: {
			...base.run,
			rules: {
				...base.run.rules,
				mode: 'nemesis',
				startedCount: players.length,
			},
			players: Object.fromEntries(
				Object.entries(base.run.players).map(([player, entry]) => [
					player,
					{ ...entry, ante },
				]),
			),
			pairings: {
				[ante]: { ante, partners, usedPairs: pairs, lastBye: bye ?? null },
			},
		},
	}
}
