import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import type { Result } from '../../shared/utils/result.js'

// Live In Queue / In Game counts for the Stats page, from Nakama's
// queue_counts RPC (nakama/src/matchmaking/queue.ts). The RPC lists only the
// game modes that have players now; the website fills in the rest with 0.

export const QUEUE_STATS_MODS = ['MultiplayerPvP', 'MultiplayerSPDRN'] as const
export type QueueStatsMod = (typeof QUEUE_STATS_MODS)[number]

export interface GameModeCounts {
	queued: number
	inMatch: number
}

export interface QueueCountsAnswer {
	modId: string
	gameModes: Record<string, GameModeCounts>
}

// null: Nakama did not answer for that mod, so the page shows "unavailable".
export type QueueStats = Record<
	QueueStatsMod,
	Record<string, GameModeCounts> | null
>

export type FetchQueueCounts = (
	modId: QueueStatsMod,
) => Promise<Result<QueueCountsAnswer, NakamaRpcError>>

// Every visitor polls the page, so the answer is cached briefly: at most one
// Nakama call per mod per ttl. The pending promise is cached too, so
// requests that arrive during a call share it.
export function createQueueStats(fetchCounts: FetchQueueCounts, ttlMs: number) {
	let cached: Promise<QueueStats> | null = null
	let cachedAt = 0

	async function load(): Promise<QueueStats> {
		const answers = await Promise.all(
			QUEUE_STATS_MODS.map((modId) => fetchCounts(modId)),
		)
		const stats = {} as QueueStats
		QUEUE_STATS_MODS.forEach((modId, i) => {
			const answer = answers[i]
			stats[modId] = answer.ok ? answer.value.gameModes : null
		})
		return stats
	}

	return function getQueueStats(now: number): Promise<QueueStats> {
		if (!cached || now - cachedAt >= ttlMs) {
			cached = load()
			cachedAt = now
		}
		return cached
	}
}
