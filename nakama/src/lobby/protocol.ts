// Wire protocol between MPAPI (networking/nakama_lobby.lua) and the bmp_lobby
// match. Every payload is JSON. Op codes are plain objects rather than enums:
// isolatedModules builds can't inline const enums.
export const LOBBY_MATCH = 'bmp_lobby'

export const ClientOp = {
	// {} -- leave for good (not a disconnect: no grace period).
	LEAVE: 1,
	// {playerId} -- host only.
	KICK: 2,
	// {metadata} -- host only; shallow-merged into the lobby metadata.
	SET_METADATA: 3,
	// {state} -- the sender's own state, handed back in the snapshot on rejoin.
	SET_STATE: 4,
	// ActionMessage -- a relayed action (to a player id or '*'), or an
	// authoritative one (to 'server').
	ACTION: 5,
} as const

export const ServerOp = {
	// Snapshot, to the joining player only.
	SNAPSHOT: 100,
	// LobbyEventMessage, same shape as the API's lobby/{code}/events payloads.
	EVENT: 101,
	// The full metadata object.
	METADATA: 102,
	// {playerId, info} -- info is null when the player is gone.
	PLAYER_INFO: 103,
	// {message}, to the sender of a rejected op.
	ERROR: 104,
	// ActionEnvelope -- a relayed action, or an authoritative action's result
	// (from 'server').
	ACTION: 105,
	// {cid, action, reason}, to the sender of a refused ACTION.
	ACTION_REJECTED: 106,
} as const

// Where an ACTION goes: a player id, '*' for everyone (the sender included,
// as over MQTT), or SERVER_TARGET for an authoritative action.
export const BROADCAST_TARGET = '*'
export const SERVER_TARGET = 'server'

// What a client sends. `from` is never read: the server stamps the sender.
export interface ActionMessage {
	cid: string
	action: string
	to: string
	params: unknown
	responseTo?: string
}

// What a client receives.
export interface ActionEnvelope {
	cid: string
	action: string
	from: string
	to: string
	params: unknown
	responseTo?: string
}

export interface ActionRejection {
	cid: string
	action: string
	reason: string
}

// One player's finishing position, as every participant reports it.
export interface Placement {
	playerId: string
	place: number
	performance?: number
	metric?: number
}

// A participant of a started game, captured at the start (they may leave).
export interface Participant {
	id: string
	displayName: string
}

export interface StartedGame {
	runId: string
	seed: string
	stake: number | null
	options: unknown
	startedAt: number
	hostId: string
	players: Participant[]
}

// One player's replay events in arrival order, each the JSON text of its
// [t, opcode, args] tuple as encoded on arrival. Kept as text because object
// keys don't keep their order once match state has been through the Go
// runtime, and the log's hash (log_check.ts) is over the client's key order.
export interface PlayerLog {
	lines: string[]
	bytes: number
	truncated: boolean
}

// State the server owns for its authoritative actions (src/actions).
export interface GameState {
	// userId -> ready. Absent means not ready.
	ready: { [userId: string]: boolean }
	started: null | StartedGame
	// userId -> that participant's report of the placements.
	reports: { [userId: string]: Placement[] }
	// Report order, for breaking a disputed tie with no host report.
	reportOrder: string[]
	// When the result clock started: the first report, or the game dropping
	// under two remaining participants.
	settleFrom: number | null
	logs: { [userId: string]: PlayerLog }
}

// What clients see of GameState (logs stay on the server).
export interface GameView {
	ready: { [userId: string]: boolean }
	started: null | StartedGame
	reported: string[]
}

// agreed: every participant reported the same places. partial: whoever
// reported agreed, but not everyone reported. disputed: reports differ (the
// majority's -- or the host's -- is recorded). abandoned: no result.
// restarted: the host restarted the game.
export type RunStatus =
	| 'agreed'
	| 'partial'
	| 'disputed'
	| 'abandoned'
	| 'restarted'

// A stored replay log against the client's own closing hash (log_check.ts).
export type LogCheck = 'match' | 'mismatch' | 'unavailable'

// A finished game, as stored in RUNS_COLLECTION.
export interface RunRecord {
	runId: string
	code: string
	modId: string
	seed: string
	stake: number | null
	options: unknown
	startedAt: number
	endedAt: number
	status: RunStatus
	placements: Placement[]
	reports: { [userId: string]: Placement[] }
	players: Participant[]
}

// GAME_ENDED event data.
export interface GameEnded {
	runId: string
	status: RunStatus
	placements: Placement[]
}

// The LobbyEvent wire strings MPAPI already handles (domain/lobby_event.lua).
export type LobbyEventType =
	| 'player_joined'
	| 'player_left'
	| 'player_kicked'
	| 'player_disconnected'
	| 'player_reconnected'
	| 'metadata_changed'
	| 'host_changed'
	| 'lobby_closed'
	| 'game_ended'

export interface LobbyEventMessage {
	type: LobbyEventType
	lobbyCode: string
	playerId?: string
	displayName?: string
	data?: unknown
}

export interface PlayerInfo {
	displayName: string
	preferredJoker: string | null
	mods: unknown
}

export interface SnapshotPlayer extends PlayerInfo {
	id: string
	isAway: boolean
}

export interface Snapshot {
	code: string
	modId: string
	hostId: string
	maxPlayers: number
	type: 'private'
	metadata: { [key: string]: unknown }
	players: SnapshotPlayer[]
	ownState: unknown
	game: GameView
}

// matchSignal payloads (from RPCs) and replies.
export type LobbySignal =
	| { type: 'has_player'; userId: string }
	| { type: 'leave'; userId: string }

// Storage object (per user) naming the lobby they are in, for reconnect after
// a game restart. Written and removed by the match only.
export const CURRENT_LOBBY_COLLECTION = 'lobby'
export const CURRENT_LOBBY_KEY = 'current'

// code -> {matchId, modId}, owned by the system user. Match labels can't be
// used to find a lobby by code: Nakama indexes them asynchronously, so a
// just-created lobby isn't findable for a moment. A write with version '*'
// only succeeds if the code is free, which makes reserving one atomic.
export const LOBBY_CODE_COLLECTION = 'lobby_codes'
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

// Finished games (src/lobby/storage.ts). Runs and logs are owned by the
// system user; each participant gets a pointer in MY_RUNS_COLLECTION.
export const RUNS_COLLECTION = 'match_runs'
export const LOGS_COLLECTION = 'match_logs'
export const MY_RUNS_COLLECTION = 'my_runs'
