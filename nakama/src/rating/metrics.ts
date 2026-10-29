// Secondary leaderboard metrics: a per-mod personal best tracked alongside
// the rating. The same table as apps/server's features/ratings/metrics.config.ts
// (client-reported and plausibility-bounded, never re-simulated).

import { compareScores, fromNumber, normalizeScore } from '../../../packages/types/src/big-score'

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

const BOUNDS = {
	// A legitimate ranked run can't complete in under 10s nor take over 6h.
	time_ms: { min: 10_000, max: 6 * 60 * 60 * 1000 },
}

// What a placement reports for the season best: score text for a score board,
// a plain number for a time board. Each board reads only its own field.
export interface ReportedMetric {
	metric?: number
	metricText?: string
}

// A stored season best, shown the way its board keeps it: score text for a
// score board (a stored plain number becomes its score text), a number for a time
// board. Anything else is null.
export function seasonBestOf(modId: string, stored: unknown): number | string | null {
	const config = METRIC_CONFIG[modId]
	if (!config) return null
	if (config.kind === 'score') {
		if (typeof stored === 'string') return normalizeScore(stored)
		if (typeof stored === 'number' && Number.isFinite(stored)) return fromNumber(stored)
		return null
	}
	return typeof stored === 'number' && Number.isFinite(stored) ? stored : null
}

// The value to store as the player's season best, or the current best when
// the report has none, it is out of range or malformed (dropped, not clamped)
// or no better.
export function nextSeasonBest(
	modId: string,
	reported: ReportedMetric,
	current: number | string | null,
): number | string | null {
	const config = METRIC_CONFIG[modId]
	if (!config) return current
	if (config.kind === 'score') {
		const best = seasonBestOf(modId, current)
		const text = reported.metricText === undefined ? null : normalizeScore(reported.metricText)
		if (text === null) return best
		if (best === null) return text
		return compareScores(text, best as string) === 1 ? text : best
	}
	const value = reported.metric
	if (value === undefined) return current
	const bounds = BOUNDS.time_ms
	if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) return current
	if (typeof current !== 'number') return value
	return value < current ? value : current
}
