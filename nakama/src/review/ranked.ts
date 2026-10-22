// Whether a player is in ranked play right now: holding a live ranked queue
// ticket, or seated in a started ranked lobby. The API's integrity item
// (service queue) is raised for a failed launcher challenge in either.
import type { QueueRecord } from '../matchmaking/queue'

export interface RankedContext {
	queued: boolean
	inGame: boolean
}

export function isRankedGameMode(gameMode: string): boolean {
	return gameMode.indexOf('ranked:') === 0
}

// label: the seated lobby's match label (lobby/state.ts labelOf), or null.
export function rankedContextOf(records: QueueRecord[], label: string | null): RankedContext {
	let inGame = false
	if (label) {
		try {
			const parsed = JSON.parse(label) as { mode?: unknown; started?: unknown }
			inGame = typeof parsed.mode === 'string' && isRankedGameMode(parsed.mode) && parsed.started === true
		} catch (e) {
			inGame = false
		}
	}
	return { queued: records.some((r) => isRankedGameMode(r.gameMode)), inGame }
}

// What kind of game a lobby holds, for the service queue's priority: ranked
// and casual matchmade games, or a private lobby.
export type LobbyKind = 'ranked' | 'casual' | 'private'

export function lobbyKindOf(lobby: { rankedMode?: string; gameMode?: string; allowedIds?: unknown }): LobbyKind {
	if (lobby.rankedMode || (lobby.gameMode && isRankedGameMode(lobby.gameMode))) return 'ranked'
	return lobby.allowedIds || lobby.gameMode ? 'casual' : 'private'
}

// The same from a match label (lobby/state.ts labelOf), or null without one.
export function lobbyKindOfLabel(label: string | null | undefined): LobbyKind | null {
	if (!label) return null
	try {
		const parsed = JSON.parse(label) as { mode?: unknown; type?: unknown }
		const mode = typeof parsed.mode === 'string' ? parsed.mode : ''
		if (isRankedGameMode(mode)) return 'ranked'
		return parsed.type === 'public' || mode ? 'casual' : 'private'
	} catch (e) {
		return null
	}
}
