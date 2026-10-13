// Graceful restart: a lobby outlives a Nakama restart. On shutdown (Nakama's
// shutdown_grace_sec) each lobby match writes a checkpoint instead of closing;
// the first lobby_current or lobby_find that finds the match gone but the
// checkpoint there claims it and starts a new match from it, under the same
// code. Every player comes back away, with a fresh grace period to rejoin in.
import { bindCode } from './codes'
import {
	CHECKPOINT_TTL_MS,
	CURRENT_LOBBY_COLLECTION,
	CURRENT_LOBBY_KEY,
	LOBBY_CHECKPOINT_COLLECTION,
	LOBBY_MATCH,
	SYSTEM_USER_ID,
} from './protocol'
import type { Lobby } from './state'

export { CHECKPOINT_TTL_MS }
// A claim whose resume never finished (the claimer failed midway) can be
// taken over after this long.
export const CLAIM_TIMEOUT_MS = 30_000

export interface Checkpoint {
	lobby: Lobby
	// When the lobby stopped.
	at: number
	// When a resume claimed it, or null.
	claimedAt: number | null
}

// What a lobby is worth keeping across a restart: one with players in it.
export function checkpointOf(lobby: Lobby, now: number): Checkpoint | null {
	if (lobby.closed || lobby.players.length === 0) return null
	return { lobby, at: now, claimedAt: null }
}

export function isExpired(checkpoint: Checkpoint, now: number): boolean {
	return now - checkpoint.at >= CHECKPOINT_TTL_MS
}

export function isClaimable(checkpoint: Checkpoint, now: number): boolean {
	return (
		!isExpired(checkpoint, now) &&
		(checkpoint.claimedAt === null || now - checkpoint.claimedAt >= CLAIM_TIMEOUT_MS)
	)
}

// The lobby a resumed match starts with. Every player is away (nobody is
// attached yet) from now, so each gets the whole grace period; the result
// clock moves on by the time the server was down, so the restart doesn't eat
// into it. Spectators and rate-limit buckets don't carry over.
export function resumeFrom(checkpoint: Checkpoint, now: number): Lobby {
	const lobby = checkpoint.lobby
	const downtime = Math.max(0, now - checkpoint.at)
	const settleFrom = lobby.game.settleFrom
	return {
		...lobby,
		createdAt: now,
		players: lobby.players.map((p) => ({ ...p, sessionId: '', awaySince: now })),
		spectators: [],
		actionBudget: {},
		game: {
			...lobby.game,
			settleFrom: settleFrom === null ? null : settleFrom + downtime,
		},
	}
}

function keyOf(code: string) {
	return { collection: LOBBY_CHECKPOINT_COLLECTION, key: code, userId: SYSTEM_USER_ID }
}

function write(nk: nkruntime.Nakama, code: string, checkpoint: Checkpoint, version?: string) {
	nk.storageWrite([
		{
			...keyOf(code),
			value: checkpoint as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
			version,
		},
	])
}

export function saveCheckpoint(nk: nkruntime.Nakama, checkpoint: Checkpoint) {
	write(nk, checkpoint.lobby.code, checkpoint)
}

export function readCheckpoint(
	nk: nkruntime.Nakama,
	code: string,
): { checkpoint: Checkpoint; version: string } | null {
	const objects = nk.storageRead([keyOf(code)])
	if (objects.length === 0) return null
	return { checkpoint: objects[0].value as unknown as Checkpoint, version: objects[0].version || "" }
}

export function deleteCheckpoint(nk: nkruntime.Nakama, code: string) {
	nk.storageDelete([keyOf(code)])
}

export type ResumeResult =
	| { kind: 'none' }
	// Another caller is resuming it right now: ask again in a moment.
	| { kind: 'resuming' }
	| { kind: 'resumed'; matchId: string; modId: string }

// Brings back the lobby behind `code` from its checkpoint, if there is one.
// The claim is a version-checked write, so only one caller creates the match.
export function resumeLobby(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger | null,
	code: string,
	now: number,
): ResumeResult {
	const found = readCheckpoint(nk, code)
	if (!found) return { kind: 'none' }
	const checkpoint = found.checkpoint
	if (isExpired(checkpoint, now)) {
		deleteCheckpoint(nk, code)
		return { kind: 'none' }
	}
	if (!isClaimable(checkpoint, now)) return { kind: 'resuming' }
	try {
		write(nk, code, { ...checkpoint, claimedAt: now }, found.version)
	} catch (e) {
		return { kind: 'resuming' }
	}

	const lobby = checkpoint.lobby
	const matchId = nk.matchCreate(LOBBY_MATCH, { resumeCode: code })
	bindCode(nk, code, matchId, lobby.modId)
	for (const p of lobby.players) {
		nk.storageWrite([
			{
				collection: CURRENT_LOBBY_COLLECTION,
				key: CURRENT_LOBBY_KEY,
				userId: p.id,
				value: { matchId, code, modId: lobby.modId },
				permissionRead: 0,
				permissionWrite: 0,
			},
		])
	}
	deleteCheckpoint(nk, code)
	if (logger) logger.info('Lobby %s resumed from its checkpoint as %s', code, matchId)
	return { kind: 'resumed', matchId, modId: lobby.modId }
}
