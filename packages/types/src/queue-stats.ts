// GET /api/stats/queues: the live In Queue / In Game counts the Stats page
// shows, from Nakama's queue_counts RPC (nakama/src/matchmaking/queue.ts).

export const QUEUE_STATS_MODS = ['MultiplayerPvP', 'MultiplayerSPDRN'] as const
export type QueueStatsMod = (typeof QUEUE_STATS_MODS)[number]

export interface GameModeCounts {
	queued: number
	inMatch: number
}

// Per mod, the counts by game mode key (ranked keys carry `ranked:`). Only
// the modes with players now are listed. null: Nakama did not answer for
// that mod, so the page shows "unavailable".
export type QueueStatsResponse = Record<
	QueueStatsMod,
	Record<string, GameModeCounts> | null
>
