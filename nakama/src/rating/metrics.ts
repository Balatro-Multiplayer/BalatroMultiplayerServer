// Secondary leaderboard metrics: a per-mod personal best tracked alongside
// the rating. The same table as apps/server's features/ratings/metrics.config.ts
// (client-reported and plausibility-bounded, never re-simulated).
export type MetricKind = 'score' | 'time_ms'

export interface MetricConfig {
	kind: MetricKind
	// 'desc' = higher is better (score). 'asc' = lower is better (time).
	direction: 'asc' | 'desc'
}

// Keys must match each mod's real manifest id (PVP.id, SPDRN.id).
const METRIC_CONFIG: { [modId: string]: MetricConfig } = {
	MultiplayerPvP: { kind: 'score', direction: 'desc' },
	MultiplayerSPDRN: { kind: 'time_ms', direction: 'asc' },
}

const BOUNDS: { [kind in MetricKind]: { min: number; max: number } } = {
	score: { min: 0, max: 1e15 },
	// A legitimate ranked run can't complete in under 10s nor take over 6h.
	time_ms: { min: 10_000, max: 6 * 60 * 60 * 1000 },
}

// The value to store as the player's season best, or the current best when
// the reported value is missing, out of range (rejected, not clamped) or no
// better.
export function nextSeasonBest(
	modId: string,
	reported: number | undefined,
	current: number | null,
): number | null {
	const config = METRIC_CONFIG[modId]
	if (!config || reported === undefined) return current
	const bounds = BOUNDS[config.kind]
	if (!Number.isFinite(reported) || reported < bounds.min || reported > bounds.max)
		return current
	if (current === null) return reported
	const better = config.direction === 'asc' ? reported < current : reported > current
	return better ? reported : current
}
