// The hourly purge of moderation evidence: expired flagged messages and
// reported lobbies' kept chat. Which rows go is decided by
// features/service-queue/purge.ts; this reads the facts and deletes.
import { and, eq, inArray, lt, max, sql } from 'drizzle-orm'
import {
	flaggedMessagePurgeable,
	reportedLobbyPurgeable,
} from '../../features/service-queue/purge.js'
import { db } from '../db/index.js'
import { flaggedMessages, reportedLobbyMessages, reports, serviceQueueItems } from '../db/schema.js'
import { openSourceIds } from './service-queue.gateway.js'

export async function purgeExpiredFlaggedMessages(now: Date = new Date()): Promise<number> {
	const expired = await db
		.select({ id: flaggedMessages.id, expiresAt: flaggedMessages.expiresAt })
		.from(flaggedMessages)
		.where(lt(flaggedMessages.expiresAt, now))
	if (expired.length === 0) return 0
	const open = await openSourceIds(
		'flagged_chat',
		expired.map((row) => String(row.id)),
	)
	const ids = expired
		.filter((row) => flaggedMessagePurgeable({ expiresAt: row.expiresAt, hasOpenItem: open.has(String(row.id)) }, now))
		.map((row) => row.id)
	if (ids.length === 0) return 0
	await db.delete(flaggedMessages).where(inArray(flaggedMessages.id, ids))
	return ids.length
}

export async function purgeReportedLobbyMessages(now: Date = new Date()): Promise<number> {
	// Lobbies with at least one expired line are the candidates.
	const lobbies = await db
		.select({ lobbyId: reportedLobbyMessages.lobbyId, latestExpiresAt: max(reportedLobbyMessages.expiresAt) })
		.from(reportedLobbyMessages)
		.groupBy(reportedLobbyMessages.lobbyId)
		.having(lt(sql`min(${reportedLobbyMessages.expiresAt})`, now))
	if (lobbies.length === 0) return 0

	const lobbyIds = lobbies.map((l) => l.lobbyId)
	// Per lobby: its open reports and the latest resolution of its report items.
	const facts = await db
		.select({
			lobbyId: reports.lobbyId,
			openReports: sql<number>`count(*) filter (where ${reports.status} = 'open')`.mapWith(Number),
			lastResolvedAt: max(serviceQueueItems.resolvedAt),
		})
		.from(reports)
		.leftJoin(
			serviceQueueItems,
			and(eq(serviceQueueItems.itemType, 'report'), eq(serviceQueueItems.sourceId, sql`${reports.id}::text`)),
		)
		.where(inArray(reports.lobbyId, lobbyIds))
		.groupBy(reports.lobbyId)
	const factsOf = new Map(facts.map((f) => [f.lobbyId, f]))

	const purgeable = lobbies
		.filter((lobby) =>
			reportedLobbyPurgeable(
				{
					openReports: factsOf.get(lobby.lobbyId)?.openReports ?? 0,
					lastResolvedAt: factsOf.get(lobby.lobbyId)?.lastResolvedAt ?? null,
					latestExpiresAt: lobby.latestExpiresAt ?? now,
				},
				now,
			),
		)
		.map((lobby) => lobby.lobbyId)
	if (purgeable.length === 0) return 0
	const deleted = await db
		.delete(reportedLobbyMessages)
		.where(inArray(reportedLobbyMessages.lobbyId, purgeable))
		.returning({ id: reportedLobbyMessages.id })
	return deleted.length
}
