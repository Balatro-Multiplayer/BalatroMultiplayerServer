import { eq, sql } from 'drizzle-orm'
import type { ChatRows, ForfeitRow, RunRows } from '../../features/nakama/mirror.service.js'
import { db } from '../db/index.js'
import {
	chatLogs,
	flaggedMessages,
	lobbyRuns,
	matchResultConflicts,
	matchRunLogs,
	matchmakingMatches,
	matchmakingRatings,
} from '../db/schema.js'
import { hasOpenForfeitReconciliationFlag, insertForfeitReconciliationFlag } from './forfeit-reconciliation.gateway.js'
import { enqueueServiceQueueItem } from './service-queue.gateway.js'

// Writes what the Nakama mirror pulled (features/nakama/mirror.service.ts).
// Every write is an upsert keyed by the run id or the outbox key, so storing
// the same entry twice (the API died before acking it) changes nothing.

export async function storeMirroredRun(rows: RunRows): Promise<void> {
	await db.transaction(async (tx) => {
		const { lobbyRun } = rows
		await tx
			.insert(lobbyRuns)
			.values(lobbyRun)
			.onConflictDoUpdate({
				target: lobbyRuns.id,
				set: { status: lobbyRun.status, finalizedAt: lobbyRun.finalizedAt },
			})
		for (const log of rows.logs) {
			await tx
				.insert(matchRunLogs)
				.values(log)
				.onConflictDoUpdate({
					target: [matchRunLogs.runId, matchRunLogs.playerId],
					set: {
						compressedEvents: log.compressedEvents,
						carbonHash: log.carbonHash,
						eventCount: log.eventCount,
						status: log.status,
						flagReason: log.flagReason,
						finalizedAt: log.finalizedAt,
						expiresAt: log.expiresAt,
					},
				})
		}
		if (rows.match) {
			await tx.insert(matchmakingMatches).values(rows.match).onConflictDoNothing({ target: matchmakingMatches.matchId })
		}
		for (const rating of rows.ratings) {
			// Nakama owns the rating; the row is its latest copy.
			await tx
				.insert(matchmakingRatings)
				.values(rating)
				.onConflictDoUpdate({
					target: [
						matchmakingRatings.playerId,
						matchmakingRatings.modId,
						matchmakingRatings.gameMode,
						matchmakingRatings.season,
					],
					set: {
						rating: rating.rating,
						wins: rating.wins,
						losses: rating.losses,
						gamesPlayed: rating.gamesPlayed,
						seasonBest: rating.seasonBest,
						lastMatchAt: rating.lastMatchAt,
						updatedAt: sql`now()`,
					},
				})
		}
		// Once per run: a retried entry finds them already there.
		if (rows.conflicts.length > 0) {
			const [existing] = await tx
				.select({ id: matchResultConflicts.id })
				.from(matchResultConflicts)
				.where(eq(matchResultConflicts.matchId, rows.lobbyRun.id))
				.limit(1)
			if (!existing) await tx.insert(matchResultConflicts).values(rows.conflicts)
		}
	})
	// After the commit: the queue item points at rows that now exist. One
	// item per run, as replay-log.service.ts files it (sourceId = run id).
	for (const flag of rows.flagged) {
		await enqueueServiceQueueItem({
			itemType: 'anti_cheat',
			sourceId: rows.lobbyRun.id,
			subjectPlayerId: flag.playerId,
			summary: `Anti-cheat flag (${flag.reason})`,
		})
	}
	if (rows.conflicts.length > 0) {
		const conflicts = await db
			.select({ id: matchResultConflicts.id })
			.from(matchResultConflicts)
			.where(eq(matchResultConflicts.matchId, rows.lobbyRun.id))
		for (const conflict of conflicts) {
			await enqueueServiceQueueItem({
				itemType: 'match_conflict',
				sourceId: String(conflict.id),
				subjectPlayerId: null,
				summary: `Match result conflict — lobby ${rows.lobbyRun.lobbyCode}`,
			})
		}
	}
}

export async function storeMirroredForfeit(row: ForfeitRow): Promise<void> {
	if (await hasOpenForfeitReconciliationFlag(row.matchId, row.playerId)) return
	await insertForfeitReconciliationFlag(row)
}

export async function storeMirroredChat(rows: ChatRows): Promise<void> {
	await db.insert(chatLogs).values(rows.chat).onConflictDoNothing()
	const flagged = rows.flaggedMessage
	if (!flagged) return
	await db.insert(flaggedMessages).values(flagged).onConflictDoNothing()
	const [row] = await db
		.select({ id: flaggedMessages.id })
		.from(flaggedMessages)
		.where(eq(flaggedMessages.mirrorKey, flagged.mirrorKey))
	if (!row) return
	const band = (flagged.matches as { band?: string }).band ?? 'unknown'
	await enqueueServiceQueueItem({
		itemType: 'flagged_chat',
		sourceId: String(row.id),
		subjectPlayerId: flagged.playerId,
		summary: `Flagged chat — remote moderation (band: ${band})`,
	})
}
