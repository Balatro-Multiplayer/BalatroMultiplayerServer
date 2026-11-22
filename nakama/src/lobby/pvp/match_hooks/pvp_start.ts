// How a PvP match starts: the Setup plan, the ranked rules lock, the limits freeze, and the
// one writer of the run. Pure functions of the lobby and plain data; no hooks, no clock read.
import type { ServerConfig } from '../../../config'
import { type LobbyKind, lobbyKindOf } from '../../../review/ranked'
import { PVP_MOD_ID } from '../../../standing/pvp_version'
import type { DraftResult, VoteResult } from '../../protocol'
import type { Lobby } from '../../state'
import { newClocks } from '../core/clock'
import { seededRandom } from '../core/random'
import type { Milliseconds, Run, RunPlayer, State } from '../core/types'
import { pickMode } from '../modes'
import { lockedRulesFor } from '../rules/locked_rules'
import { settingsFromLobby } from '../rules/settings'

// ---- Setup: which steps run before the run ----

type SetupResults = { [id: string]: DraftResult | VoteResult }

interface SetupPlan {
	// The casual ruleset vote (and, for a ruleset with traps, the traps vote).
	votes: boolean
	draft: boolean
}

const VOTE_QUEUES = ['pvp_nemesis', 'pvp_royale', 'pvp_manhunt', 'pvp_teams']
// The ban-pick draft: a schedule needs exactly two players, a rotation two or more.
const SCHEDULE_QUEUES = ['pvp_nemesis', 'pvp_smallworld']
const ROTATION_QUEUES = ['pvp_royale', 'pvp_manhunt', 'pvp_teams']
const TRAP_RULESETS = ['balanced', 'expanded']

export function planOf(
	kind: LobbyKind,
	queueMode: unknown,
	players: number,
): SetupPlan {
	const queue = typeof queueMode === 'string' ? queueMode : ''
	const draftFits = SCHEDULE_QUEUES.includes(queue)
		? players === 2
		: ROTATION_QUEUES.includes(queue) && players >= 2
	return {
		votes: kind === 'casual' && VOTE_QUEUES.includes(queue),
		draft: kind !== 'private' && draftFits,
	}
}

// The step still to run, in order, or null when Setup is over.
export function nextStep(
	plan: SetupPlan,
	results: SetupResults,
): 'ruleset' | 'traps' | 'draft' | null {
	if (plan.votes) {
		const ruleset = results.ruleset
		if (ruleset === undefined || ruleset.kind !== 'vote') return 'ruleset'
		if (TRAP_RULESETS.includes(ruleset.option) && results.traps === undefined)
			return 'traps'
	}
	return plan.draft && results.draft === undefined ? 'draft' : null
}

export const setupDone = (plan: SetupPlan, results: SetupResults): boolean =>
	nextStep(plan, results) === null

// ---- Starting the run ----

type Rejected = { ok: false; reject: string }
const refuse = (reject: string): Rejected => ({ ok: false, reject })

// The lobby's rules as the run reads them: the metadata, the ruleset a vote rolled, then the
// ranked lock over both (a ranked lobby plays nothing else).
export function rulesOf(
	lobby: Lobby,
): { ok: true; rules: { [key: string]: unknown } } | Rejected {
	const locked = lockedRulesFor(lobby.modId, lobby.rankedMode ?? '', PVP_MOD_ID)
	if (!locked.ok) return refuse('bad_rules')
	const vote = lobby.game.setup?.results.ruleset
	const rolled =
		vote !== undefined && vote.kind === 'vote'
			? { ruleset: `ruleset_mp_${vote.option}` }
			: {}
	return { ok: true, rules: { ...lobby.metadata, ...rolled, ...locked.locked } }
}

export const setupDoneFor = (lobby: Lobby, queueMode: unknown): boolean =>
	setupDone(
		planOf(
			lobbyKindOf(lobby),
			queueMode,
			lobby.game.started?.players.length ?? 0,
		),
		lobby.game.setup?.results ?? {},
	)

const emptyInbox = (): RunPlayer => ({
	inbox: [],
	inboxDone: 0,
	totals: {},
	ante: null,
	location: null,
	sells: {},
	shopSpends: {},
	results: {},
	vouchers: [],
})

// The one writer of the run: builds it from the lobby once Setup is done, locks the ranked
// rules, and freezes the rules and the limits into it. Every started player is in, absent
// or not: an absent one is an away player (shellTick). A missing fact refuses.
export function startPvpRun(
	lobby: Lobby,
	config: ServerConfig,
	now: Milliseconds,
): { ok: true; state: State } | Rejected {
	const started = lobby.game.started
	const base = lobby.game.pvp
	if (started === null || base === undefined) return refuse('no_game')
	if (base.run !== null) return refuse('run_started')
	const merged = rulesOf(lobby)
	if (!merged.ok) return merged
	if (!setupDoneFor(lobby, merged.rules.queue_mode))
		return refuse('setup_not_done')
	const ids = started.players.map((player) => player.id)
	const found = settingsFromLobby(merged.rules, ids)
	if (!found.ok) return refuse('bad_rules')
	const picks: { [id: string]: NonNullable<State['players'][string]['team']> } =
		{}
	for (const id of ids) {
		const known = base.players[id]
		if (known === undefined) return refuse('unknown_player')
		if (known.team !== null) picks[id] = known.team
	}
	const settings = found.settings
	const mode = pickMode(settings.mode, settings.startedCount)
	const opening = mode.init(
		settings,
		{ startedIds: ids, picks, teamPlan: lobby.teamPlan ?? null },
		seededRandom(started.runId),
	)
	const players: State['players'] = {}
	const inboxes: Run['players'] = {}
	for (const id of ids) {
		players[id] = { team: opening.teams[id] ?? null }
		inboxes[id] = emptyInbox()
	}
	const limits = config.pvpLimits
	return {
		ok: true,
		state: {
			...base,
			players,
			run: {
				id: started.runId,
				rules: { ...settings, limits },
				players: inboxes,
				clocks: newClocks(ids, limits, now),
				currentPvpBlind: null,
				ready: {},
				firstReady: [],
				finishedPvpBlinds: [],
				lives: opening.lives,
				teamLives: opening.teamLives,
				waitingDeaths: [],
				exits: [],
				lifeLedger: { lifeTakenFor: {}, runOutsForgiven: {} },
				pairings: {},
				cardTargets: opening.cardTargets,
				teams: opening.teams,
				skips: {},
				votes: { draw: [], seed: [] },
				places: {},
				endGames: {},
				lastJokers: {},
			},
		},
	}
}
