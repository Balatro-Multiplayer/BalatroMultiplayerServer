import { desc, eq, inArray } from 'drizzle-orm'
import type {
	LobbyRunStatus,
	PaginatedRuns,
	RunRow,
	RunWithLogs,
} from '../../contracts/IReplayLogRepository.js'
import { db } from '../db/index.js'
import { lobbyRuns, matchRunLogs } from '../db/schema.js'

// Account-deletion side effect: gameplay logs aren't deleted (they may still
// be needed for anti-cheat/replay purposes for the remainder of their normal
// retention window), but the player is no longer identifiable via playerId
// once their account is gone.
export async function pseudonymizeRunLogsForPlayer(
	playerId: string,
): Promise<void> {
	await db
		.update(matchRunLogs)
		.set({ playerId: `deleted_user_${playerId}` })
		.where(eq(matchRunLogs.playerId, playerId))
}

// A player's own runs, for "My Matches". Two queries (run ids this player has a log row for, then
// those runs' own rows) rather than a join, since matchRunLogs has no FK
// back to a single canonical "which runs is this player in" projection and
// drizzle's own relational query builder isn't wired up elsewhere in this
// gateway (every other function here is plain query-builder style).
export async function getRunsForPlayer(
	playerId: string,
	page: number,
	pageSize: number,
): Promise<PaginatedRuns> {
	const logRows = await db
		.select({ runId: matchRunLogs.runId })
		.from(matchRunLogs)
		.where(eq(matchRunLogs.playerId, playerId))
	const runIds = [...new Set(logRows.map((r) => r.runId))]
	const total = runIds.length
	if (total === 0) return { runs: [], total: 0 }

	const rows = await db
		.select()
		.from(lobbyRuns)
		.where(inArray(lobbyRuns.id, runIds))
		.orderBy(desc(lobbyRuns.startedAt))
		.limit(pageSize)
		.offset((page - 1) * pageSize)

	return {
		runs: rows.map((run) => ({
			id: run.id,
			lobbyCode: run.lobbyCode,
			modId: run.modId,
			lobbyType: run.lobbyType,
			status: run.status as LobbyRunStatus,
			startedAt: run.startedAt,
			finalizedAt: run.finalizedAt,
		})),
		total,
	}
}

// Exact join for the admin Match History page's "View Log" button:
// lobbyRuns.matchmakingMatchId is populated at run-creation time
// (replay-log.service.ts, from the live matchByLobby lookup) for any run
// backing a real ranked/casual match -- unlike getMostRecentRunForLobbyCode,
// this doesn't need to guess by lobby code + recency (codes get reused
// across unrelated lobby instances over time).
export async function getRunIdsForMatchIds(
	matchIds: string[],
): Promise<Map<string, string>> {
	if (matchIds.length === 0) return new Map()
	const rows = await db
		.select({
			id: lobbyRuns.id,
			matchmakingMatchId: lobbyRuns.matchmakingMatchId,
		})
		.from(lobbyRuns)
		.where(inArray(lobbyRuns.matchmakingMatchId, matchIds))
	const map = new Map<string, string>()
	for (const row of rows) {
		if (row.matchmakingMatchId) map.set(row.matchmakingMatchId, row.id)
	}
	return map
}

export async function getRunWithLogs(
	runId: string,
): Promise<RunWithLogs | undefined> {
	const [run] = await db.select().from(lobbyRuns).where(eq(lobbyRuns.id, runId))
	if (!run) return undefined

	const logs = await db
		.select({
			playerId: matchRunLogs.playerId,
			compressedEvents: matchRunLogs.compressedEvents,
			carbonHash: matchRunLogs.carbonHash,
			eventCount: matchRunLogs.eventCount,
			status: matchRunLogs.status,
			flagReason: matchRunLogs.flagReason,
		})
		.from(matchRunLogs)
		.where(eq(matchRunLogs.runId, runId))

	return {
		run: {
			id: run.id,
			lobbyCode: run.lobbyCode,
			modId: run.modId,
			lobbyType: run.lobbyType,
			status: run.status as LobbyRunStatus,
			startedAt: run.startedAt,
			finalizedAt: run.finalizedAt,
		},
		logs: logs.map((log) => ({
			...log,
			status: log.status as RunWithLogs['logs'][number]['status'],
			flagReason: log.flagReason as RunWithLogs['logs'][number]['flagReason'],
		})),
	}
}
