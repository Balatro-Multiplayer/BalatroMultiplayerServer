import { QUEUE_STATS_MODS, type QueueStatsResponse } from '@bmp/types'
import type { FetchQueueCounts } from '../../contracts/IStatsSources.js'
import { createTtlCache } from '../../shared/utils/ttl-cache.js'

// Live In Queue / In Game counts for the Stats page, from Nakama's
// queue_counts RPC (nakama/src/matchmaking/queue.ts). The RPC lists only the
// game modes that have players now; the website fills in the rest with 0.

// Every visitor polls the page, so the answer is cached: at most one Nakama
// call per mod per ttl.
export function createQueueStats(fetchCounts: FetchQueueCounts, ttlMs: number) {
	return createTtlCache(async (): Promise<QueueStatsResponse> => {
		const answers = await Promise.all(
			QUEUE_STATS_MODS.map((modId) => fetchCounts(modId)),
		)
		const stats = {} as QueueStatsResponse
		QUEUE_STATS_MODS.forEach((modId, i) => {
			const answer = answers[i]
			stats[modId] = answer.ok ? answer.value.gameModes : null
		})
		return stats
	}, ttlMs)
}
