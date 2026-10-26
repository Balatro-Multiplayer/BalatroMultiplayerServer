// The hourly purge of reported lobbies' kept chat. Which rows go is decided by
// features/service-queue/purge.ts; this reads the facts and deletes.
import { and, eq, inArray, lt, max, sql } from 'drizzle-orm'
import { reportedLobbyPurgeable } from '../../features/service-queue/purge.js'
import { db } from '../db/index.js'
import { reportedLobbyMessages, reports, serviceQueueItems } from '../db/schema.js'

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
