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
} as const

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
