// Lobbies and Setup results the shell and start tests build matches from, and lobbies played
// through the relay the way the mod drives them.
import { finishGame } from '../../../actions/results'
import { DEFAULT_CONFIG, type ServerConfig } from '../../../config'
import { PVP_MOD_ID } from '../../../standing/pvp_version'
import type { DraftResult, PlayerInfo, VoteResult } from '../../protocol'
import { action } from '../../relay'
import { type Lobby, join, newLobby } from '../../state'
import type { State } from '../core/types'
import type { PvpMode } from '../rules/settings'
import { startPvpRun } from '../match_hooks/pvp_start'
import { withRules } from './rules'
import { LIMITS } from './state'

export const NOW = 10_000
export const CONFIG: ServerConfig = { ...DEFAULT_CONFIG, pvpLimits: LIMITS }
export const ANN_BOB = ['ann', 'bob']

export const vote = (option: string): VoteResult => ({
	kind: 'vote',
	option,
	counts: { [option]: 1 },
})
export const draft: DraftResult = { kind: 'draft', survivors: [], banned: [] }

export const info = (pvpVersion?: string): PlayerInfo => ({
	displayName: 'x',
	preferredJoker: null,
	mods: null,
	...(pvpVersion === undefined ? {} : { pvpVersion }),
})

export interface LobbyParts {
	ids?: string[]
	ranked?: boolean
	casual?: boolean
	metadata?: { [key: string]: unknown }
	results?: { [id: string]: DraftResult | VoteResult }
	away?: string[]
	teamPlan?: [string[], string[]] | null
	version?: string
}

// A lobby with its game started and the PvP match not yet built.
export function lobbyOf(parts: LobbyParts = {}): Lobby {
	const ids = parts.ids ?? ANN_BOB
	const base = newLobby({
		code: 'ABC123',
		modId: PVP_MOD_ID,
		maxPlayers: 8,
		creatorId: ids[0],
		now: 0,
		graceMs: 120_000,
		...(parts.ranked === true ? { rankedMode: 'pvp_ranked_vanilla' } : {}),
		...(parts.casual === true ? { allowedIds: ids, gameMode: 'pvp' } : {}),
		teamPlan: parts.teamPlan ?? null,
	})
	return {
		...base,
		metadata: withRules(parts.metadata),
		players: ids.map((id) => ({
			id,
			sessionId: `${id}-s1`,
			info: info(parts.version),
			awaySince: parts.away?.includes(id) === true ? 5_000 : null,
			awayReason: parts.away?.includes(id) === true ? 'dropped' : null,
			catchingUpSince: null,
			ownState: null,
		})),
		game: {
			...base.game,
			started: {
				runId: 'run-1',
				seed: 'SEED',
				stake: 1,
				options: null,
				startedAt: 0,
				hostId: ids[0],
				players: ids.map((id) => ({ id, displayName: id })),
			},
			setup: { open: null, results: parts.results ?? {} },
		},
	}
}

export const matchOf = (
	lobby: Lobby,
	lobbyMode: PvpMode = 'nemesis',
): Lobby => ({
	...lobby,
	game: {
		...lobby.game,
		pvp: {
			lobbyMode,
			players: Object.fromEntries(
				(lobby.game.started?.players ?? []).map((player) => [
					player.id,
					{ team: null },
				]),
			),
			run: null,
			result: null,
		},
	},
})

export const started = (lobby: Lobby): State => {
	const result = startPvpRun(matchOf(lobby), CONFIG, NOW)
	if (!result.ok) throw new Error(result.reject)
	return result.state
}

// The relay, as the mod drives it: server rules on, every player on PvP 1.0.5.
export const SERVER_RULES: ServerConfig = {
	...CONFIG,
	pvpServerRulesVersion: '1.0.0',
}
export const PVP_PLAYER = info('1.0.5')

// Each start gets a new run id, unless the test names one.
let runCount = 0
export const relayCtx = (now: number, runId?: string) => ({
	now,
	newSeed: () => 'SEED',
	newId: () => runId ?? `run-${++runCount}`,
	random: () => 0,
	config: SERVER_RULES,
})

export const sendAction = (
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown,
	now: number,
): Lobby =>
	action(
		lobby,
		from,
		{ cid: `${key}-${from}-${now}`, action: key, to: 'server', params },
		relayCtx(now),
	).lobby

// A lobby the players joined, no game started.
export function joinedLobby(ids: string[] = ANN_BOB): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId: PVP_MOD_ID,
		maxPlayers: 8,
		creatorId: ids[0],
		now: 0,
		graceMs: 120_000,
		resultTimeoutMs: 60_000,
	})
	lobby = { ...lobby, metadata: withRules() }
	for (const id of ids) lobby = join(lobby, id, `${id}-s1`, PVP_PLAYER).lobby
	return lobby
}

// ann and bob joined and bob is Ready at 1000.
export const readyLobby = (): Lobby =>
	sendAction(joinedLobby(), 'bob', 'mpapi_ready', { ready: true }, 1000)

// ann starts the game at stake 1 at 2000.
export const startGame = (lobby: Lobby): Lobby =>
	sendAction(lobby, 'ann', 'mpapi_start_game', { stake: 1 }, 2000)

// The match decided: ann won.
export function annWon(lobby: Lobby): Lobby {
	const pvp = lobby.game.pvp
	if (pvp === undefined) throw new Error('no PvP match')
	return {
		...lobby,
		game: {
			...lobby.game,
			pvp: {
				...pvp,
				result: { kind: 'win', winners: ['ann'], rating: 'unrated' },
			},
		},
	}
}

// A 1v1 that ann won, closed at 5000 into the game that ended.
export const endedLobby = (): Lobby =>
	finishGame(annWon(startGame(readyLobby())), 5000, {
		status: 'agreed',
		announce: true,
		placements: [],
	}).lobby
