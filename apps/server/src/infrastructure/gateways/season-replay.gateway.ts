import { and, eq, inArray, like, sql } from 'drizzle-orm'
import type {
	MatchResult,
	PostgresRatingRow,
} from '../../features/ratings/season-replay-apply.service.js'
import { parseAntiCheatSourceId } from '../../shared/service-queue/source-ids.js'
import { db } from '../db/index.js'
import {
	matchmakingMatches,
	matchmakingRatings,
	seasonReplayBackups,
	serviceQueueItems,
} from '../db/schema.js'

// The Postgres side of the owner's Season replay apply
// (features/ratings/season-replay-apply.service.ts): the backup table, the
// rating rows and the results of the games it repairs.

const CHUNK = 500
// matchmaking_ratings rows of ranked boards only (the mirror writes no others).
const RANKED_BOARDS = 'ranked:%'

const DATE_COLUMNS = ['lastMatchAt', 'bestAt', 'decayAppliedAt', 'updatedAt']

export async function saveBackup(
	season: number,
	createdBy: string,
	data: unknown,
): Promise<string> {
	const [row] = await db
		.insert(seasonReplayBackups)
		.values({ season, createdBy, data })
		.returning({ id: seasonReplayBackups.id })
	return row.id
}

// Whether a backup holds this dry run token (the apply saves it with the backup).
export async function backupWithToken(token: string): Promise<boolean> {
	const [row] = await db
		.select({ id: seasonReplayBackups.id })
		.from(seasonReplayBackups)
		.where(sql`${seasonReplayBackups.data}->>'token' = ${token}`)
		.limit(1)
	return row !== undefined
}

export async function loadBackup(
	id: string,
): Promise<{ season: number; data: unknown } | null> {
	const [row] = await db
		.select()
		.from(seasonReplayBackups)
		.where(eq(seasonReplayBackups.id, id))
		.limit(1)
	return row ? { season: row.season, data: row.data } : null
}

export async function listSeasonRatingRows(
	season: number,
): Promise<Record<string, unknown>[]> {
	return db
		.select()
		.from(matchmakingRatings)
		.where(
			and(
				eq(matchmakingRatings.season, season),
				like(matchmakingRatings.gameMode, RANKED_BOARDS),
			),
		)
}

// The matches among these runs that have a player left unrated.
export async function listUnratedMatches(
	runIds: string[],
): Promise<MatchResult[]> {
	const found: MatchResult[] = []
	for (let i = 0; i < runIds.length; i += CHUNK) {
		const rows = await db
			.select({
				matchId: matchmakingMatches.matchId,
				resultPlacements: matchmakingMatches.resultPlacements,
			})
			.from(matchmakingMatches)
			.where(inArray(matchmakingMatches.matchId, runIds.slice(i, i + CHUNK)))
		for (const row of rows) {
			const placements = row.resultPlacements
			if (
				Array.isArray(placements) &&
				placements.some((p: { rated?: boolean }) => p.rated === false)
			)
				found.push({
					matchId: row.matchId,
					resultPlacements: placements as MatchResult['resultPlacements'],
				})
		}
	}
	return found
}

// One transaction: the Season's ranked rating rows become `ratings` (a player
// the replay no longer rates loses their row) and each match gets its result.
export async function replaceSeasonRatings(
	season: number,
	ratings: Record<string, unknown>[],
	matches: MatchResult[],
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(matchmakingRatings)
			.where(
				and(
					eq(matchmakingRatings.season, season),
					like(matchmakingRatings.gameMode, RANKED_BOARDS),
				),
			)
		for (let i = 0; i < ratings.length; i += CHUNK)
			await tx
				.insert(matchmakingRatings)
				.values(ratings.slice(i, i + CHUNK) as PostgresRatingRow[])
		for (const match of matches)
			await tx
				.update(matchmakingMatches)
				.set({
					resultPlacements: match.resultPlacements,
					updatedAt: new Date(),
				})
				.where(eq(matchmakingMatches.matchId, match.matchId))
	})
}

// Backed-up rows come back from JSON: their dates are text again.
export async function restoreSeasonRatings(
	season: number,
	rows: Record<string, unknown>[],
	matches: MatchResult[],
): Promise<void> {
	const revived = rows.map((row) => {
		const out = { ...row }
		for (const column of DATE_COLUMNS)
			if (typeof out[column] === 'string') out[column] = new Date(out[column])
		return out
	})
	await replaceSeasonRatings(season, revived, matches)
}

// Open anti-cheat items about these runs (source id `runId:playerId`, or the
// bare run id on rows from before migration 0054).
export async function listOpenAntiCheatItems(
	runIds: string[],
): Promise<number[]> {
	const wanted = new Set(runIds)
	const rows = await db
		.select({ id: serviceQueueItems.id, sourceId: serviceQueueItems.sourceId })
		.from(serviceQueueItems)
		.where(
			and(
				eq(serviceQueueItems.itemType, 'anti_cheat'),
				eq(serviceQueueItems.status, 'open'),
			),
		)
	return rows
		.filter((r) =>
			wanted.has(parseAntiCheatSourceId(r.sourceId)?.runId ?? r.sourceId),
		)
		.map((r) => r.id)
}
