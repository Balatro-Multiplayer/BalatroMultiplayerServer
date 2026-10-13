import { randomUUID } from 'node:crypto'
import { compressToBase64 } from '../../shared/utils/compression.js'

// The Nakama -> Postgres mirror (nakama/src/mirror/outbox.ts): Nakama keeps
// an outbox of finished runs and chat lines, and this pulls it, stores each
// entry in the tables the website, webadmin and service queue already read,
// and acks what it stored. Every write is idempotent (keyed by the run id or
// the outbox key), so an entry pulled twice is stored once.

// ---------------------------------------------------------------------------
// What admin_mirror_pull returns
// ---------------------------------------------------------------------------

export type LogCheck = 'match' | 'mismatch' | 'unavailable'

export interface NakamaRun {
	runId: string
	code: string
	modId: string
	startedAt: number
	endedAt: number
	status: 'agreed' | 'partial' | 'disputed' | 'abandoned' | 'restarted'
	placements: { playerId: string; place: number; performance?: number; metric?: number }[]
	reports: { [userId: string]: { playerId: string; place: number }[] }
	players: { id: string; displayName: string }[]
	rankedMode?: string
	gameMode?: string
	lobbyType?: 'public' | 'private'
	logChecks?: { [userId: string]: LogCheck }
}

export interface NakamaLog {
	events: unknown[]
	eventCount: number
	truncated: boolean
	carbonHash: string | null
	check: LogCheck
}

export interface NakamaRating {
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
	seasonBest: number | null
	lastMatchAt: number
}

export interface PulledRun {
	key: string
	kind: 'run'
	at: number
	run: NakamaRun
	logs: { [userId: string]: NakamaLog }
	rating: { modId: string; mode: string; season: number } | null
	ratings: { [userId: string]: NakamaRating }
}

export interface PulledChat {
	key: string
	kind: 'chat'
	at: number
	line: { lobbyCode: string; userId: string; message: string; flagged: boolean; verdict: unknown }
}

export type PulledEntry = PulledRun | PulledChat

export interface MirrorPlayer {
	steamId: string | null
	legacyPlayerId: string | null
	displayName: string
}

export interface MirrorPull {
	entries: PulledEntry[]
	players: { [userId: string]: MirrorPlayer }
}

// ---------------------------------------------------------------------------
// The rows an entry becomes (pure)
// ---------------------------------------------------------------------------

// How long a run's logs are kept unless one is flagged (replay-log.service.ts).
export const RUN_LOG_TTL_MS = 180 * 24 * 60 * 60 * 1000
// How long a chat line is kept unless it is flagged (history.gateway.ts).
export const CHAT_LOG_TTL_MS = 90 * 24 * 60 * 60 * 1000
// How long a flagged message is kept (chat.gateway.ts).
export const FLAGGED_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface RunRows {
	lobbyRun: {
		id: string
		lobbyCode: string
		modId: string
		lobbyType: 'public' | 'private'
		matchmakingMatchId: string | null
		status: 'completed' | 'abandoned' | 'terminated'
		startedAt: Date
		finalizedAt: Date
	}
	logs: {
		runId: string
		playerId: string
		compressedEvents: string
		carbonHash: string | null
		eventCount: number
		status: 'complete' | 'partial'
		flagReason: 'hash_mismatch' | null
		finalizedAt: Date
		expiresAt: Date | null
	}[]
	// Only for a matchmade game (the API's matchmaking_matches).
	match: {
		matchId: string
		lobbyCode: string
		modId: string
		gameMode: string
		players: string[]
		lobbyState: { playerInfos: { [playerId: string]: { displayName: string } } }
		status: 'resolved'
		gameStartedAt: Date
		resultPlacements: { playerId: string; place: number }[]
		resultReportedBy: string
		resultReportedAt: Date
		createdAt: Date
	} | null
	ratings: {
		playerId: string
		modId: string
		gameMode: string
		season: number
		rating: number
		wins: number
		losses: number
		gamesPlayed: number
		seasonBest: number | null
		lastMatchAt: Date | null
	}[]
	// Players whose log failed its check: an anti_cheat service-queue item.
	flagged: { playerId: string; reason: 'hash_mismatch' }[]
}

function runStatusOf(status: NakamaRun['status']): RunRows['lobbyRun']['status'] {
	if (status === 'abandoned') return 'abandoned'
	if (status === 'restarted') return 'terminated'
	return 'completed'
}

// ids maps every Nakama user in the run to their player id.
export function runRowsOf(entry: PulledRun, ids: Map<string, string>): RunRows {
	const { run } = entry
	const finalizedAt = new Date(run.endedAt)
	const pg = (userId: string) => ids.get(userId) as string
	const seated = run.players.filter((p) => ids.has(p.id))

	const logs: RunRows['logs'] = []
	const flagged: RunRows['flagged'] = []
	for (const player of seated) {
		const log = entry.logs[player.id]
		const check = (run.logChecks && run.logChecks[player.id]) || (log ? log.check : 'unavailable')
		const flagReason = check === 'mismatch' ? 'hash_mismatch' : null
		if (flagReason) flagged.push({ playerId: pg(player.id), reason: flagReason })
		logs.push({
			runId: run.runId,
			playerId: pg(player.id),
			compressedEvents: compressToBase64(JSON.stringify(log ? log.events : [])),
			carbonHash: log ? log.carbonHash : null,
			eventCount: log ? log.eventCount : 0,
			status: check === 'unavailable' ? 'partial' : 'complete',
			flagReason,
			finalizedAt,
			expiresAt: flagReason ? null : new Date(run.endedAt + RUN_LOG_TTL_MS),
		})
	}

	const match: RunRows['match'] = run.gameMode
		? {
				matchId: run.runId,
				lobbyCode: run.code,
				modId: run.modId,
				gameMode: run.gameMode,
				players: seated.map((p) => pg(p.id)),
				lobbyState: {
					playerInfos: Object.fromEntries(seated.map((p) => [pg(p.id), { displayName: p.displayName }])),
				},
				status: 'resolved',
				gameStartedAt: new Date(run.startedAt),
				resultPlacements: run.placements
					.filter((p) => ids.has(p.playerId))
					.map((p) => ({ playerId: pg(p.playerId), place: p.place })),
				resultReportedBy: 'nakama',
				resultReportedAt: finalizedAt,
				createdAt: new Date(run.startedAt),
			}
		: null

	const ratings: RunRows['ratings'] = []
	if (entry.rating) {
		for (const userId in entry.ratings) {
			if (!ids.has(userId)) continue
			const r = entry.ratings[userId]
			ratings.push({
				playerId: pg(userId),
				modId: entry.rating.modId,
				gameMode: entry.rating.mode,
				season: entry.rating.season,
				rating: Math.round(r.rating),
				wins: r.wins,
				losses: r.losses,
				gamesPlayed: r.gamesPlayed,
				seasonBest: r.seasonBest,
				lastMatchAt: r.lastMatchAt ? new Date(r.lastMatchAt) : null,
			})
		}
	}

	return {
		lobbyRun: {
			id: run.runId,
			lobbyCode: run.code,
			modId: run.modId,
			lobbyType: run.lobbyType ?? (run.gameMode || run.rankedMode ? 'public' : 'private'),
			matchmakingMatchId: match ? match.matchId : null,
			status: runStatusOf(run.status),
			startedAt: new Date(run.startedAt),
			finalizedAt,
		},
		logs,
		match,
		ratings,
		flagged,
	}
}

export interface ChatRows {
	chat: {
		lobbyCode: string
		playerId: string
		moderationId: string | null
		message: string
		flagged: boolean
		moderationVerdict: unknown
		sentAt: Date
		expiresAt: Date | null
		mirrorKey: string
	}
	// For a flagged line: the flagged_messages row (and a service-queue item).
	flaggedMessage: {
		playerId: string
		message: string
		matches: unknown
		expiresAt: Date
		mirrorKey: string
	} | null
}

// The verdict the moderation service gave, as flagged_messages records a
// remote flag ({source, band}).
function flagMatchesOf(verdict: unknown): unknown {
	const band =
		typeof verdict === 'object' && verdict !== null && typeof (verdict as { band?: unknown }).band === 'string'
			? (verdict as { band: string }).band
			: 'unknown'
	return { source: 'remote', band }
}

export function chatRowsOf(entry: PulledChat, playerId: string, steamIdHash: string | null): ChatRows {
	const { line } = entry
	const sentAt = new Date(entry.at)
	return {
		chat: {
			lobbyCode: line.lobbyCode,
			playerId,
			moderationId: steamIdHash,
			message: line.message,
			flagged: line.flagged,
			moderationVerdict: line.verdict ?? null,
			sentAt,
			expiresAt: line.flagged ? null : new Date(entry.at + CHAT_LOG_TTL_MS),
			mirrorKey: entry.key,
		},
		flaggedMessage: line.flagged
			? {
					playerId,
					message: line.message,
					matches: flagMatchesOf(line.verdict),
					expiresAt: new Date(entry.at + FLAGGED_TTL_MS),
					mirrorKey: entry.key,
				}
			: null,
	}
}

// ---------------------------------------------------------------------------
// Storing (effects injected)
// ---------------------------------------------------------------------------

export interface MirrorDeps {
	players: {
		findPlayerIdsByNakamaUserIds(nakamaUserIds: string[]): Promise<Map<string, string>>
		findPlayerById(id: string): Promise<{ id: string } | null>
		findPlayerBySteamIdHash(hash: string): Promise<{ id: string } | null>
		linkNakamaUser(playerId: string, nakamaUserId: string): Promise<void>
		createPlayer(data: { id: string; steamName: string; steamIdHash?: string; nakamaUserId?: string }): Promise<{ id: string }>
	}
	store: {
		storeRun(rows: RunRows): Promise<void>
		storeChat(rows: ChatRows): Promise<void>
	}
	hashSteamId(steamId: string): string
}

export type MirrorService = ReturnType<typeof createMirrorService>

export function createMirrorService(deps: MirrorDeps) {
	const { players, store, hashSteamId } = deps

	// Nakama user id -> player id for everyone in the pull. A Nakama user
	// without a linked row (their first-login sync failed, or a dev device
	// login) gets one: the row their profile names, else found by Steam id,
	// else created.
	async function resolvePlayers(pulled: MirrorPull): Promise<Map<string, string>> {
		const userIds = Object.keys(pulled.players)
		const ids = await players.findPlayerIdsByNakamaUserIds(userIds)
		for (const userId of userIds) {
			if (ids.has(userId)) continue
			const info = pulled.players[userId]
			const existing =
				(info.legacyPlayerId ? await players.findPlayerById(info.legacyPlayerId) : null) ??
				(info.steamId ? await players.findPlayerBySteamIdHash(hashSteamId(info.steamId)) : null)
			if (existing) {
				await players.linkNakamaUser(existing.id, userId)
				ids.set(userId, existing.id)
				continue
			}
			const created = await players.createPlayer({
				id: randomUUID(),
				steamName: (info.displayName || 'Player').slice(0, 64),
				steamIdHash: info.steamId ? hashSteamId(info.steamId) : undefined,
				nakamaUserId: userId,
			})
			ids.set(userId, created.id)
		}
		return ids
	}

	// Stores every entry it can; returns the keys stored (to ack). An entry
	// that fails stays in the outbox for the next pull.
	async function storePull(pulled: MirrorPull): Promise<{ stored: string[]; failed: string[] }> {
		const stored: string[] = []
		const failed: string[] = []
		if (pulled.entries.length === 0) return { stored, failed }
		const ids = await resolvePlayers(pulled)
		for (const entry of pulled.entries) {
			try {
				if (entry.kind === 'run') {
					await store.storeRun(runRowsOf(entry, ids))
				} else {
					const playerId = ids.get(entry.line.userId)
					if (playerId) {
						const steamId = pulled.players[entry.line.userId]?.steamId
						await store.storeChat(chatRowsOf(entry, playerId, steamId ? hashSteamId(steamId) : null))
					}
				}
				stored.push(entry.key)
			} catch (err) {
				console.error(`[mirror] Could not store ${entry.kind} ${entry.key}:`, err)
				failed.push(entry.key)
			}
		}
		return { stored, failed }
	}

	return { resolvePlayers, storePull }
}
