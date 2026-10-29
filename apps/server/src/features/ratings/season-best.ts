// A season best as the matchmaking_ratings columns hold it. A score board
// keeps score text, its array length and its array from the top entry down
// (a row compare on length then array gives the OmegaNum order). A time board
// keeps only the bigint season_best.
import { fromNumber, normalizeScore, scoreSortKey } from '@bmp/types'
import { getMetricConfig } from './metrics.config.js'

export interface SeasonBestColumns {
	seasonBest: number | null
	seasonBestLen: number | null
	seasonBestRev: number[] | null
	seasonBestText: string | null
}

const NONE: SeasonBestColumns = {
	seasonBest: null,
	seasonBestLen: null,
	seasonBestRev: null,
	seasonBestText: null,
}

// The columns for a value Nakama stores: score text, or a number (a time, or a
// score from before score text). Null columns for no value or bad text.
export function seasonBestColumns(
	modId: string,
	value: unknown,
): SeasonBestColumns {
	const cfg = getMetricConfig(modId)
	if (!cfg) return NONE
	if (cfg.kind === 'time_ms') {
		return typeof value === 'number' && Number.isFinite(value)
			? { ...NONE, seasonBest: value }
			: NONE
	}
	const text =
		typeof value === 'string'
			? normalizeScore(value)
			: typeof value === 'number' && Number.isFinite(value)
				? fromNumber(value)
				: null
	const key = text === null ? null : scoreSortKey(text)
	if (text === null || key === null) return NONE
	// One whole number the bigint holds exactly.
	const single =
		key.len === 1 && key.rev[0] <= Number.MAX_SAFE_INTEGER ? key.rev[0] : null
	return {
		seasonBest: single,
		seasonBestLen: key.len,
		seasonBestRev: key.rev,
		seasonBestText: text,
	}
}

// What an API reader gets: score text for a score row, else the number.
export function seasonBestOut(row: {
	seasonBest: unknown
	seasonBestText: string | null
}): number | string | null {
	if (row.seasonBestText !== null && row.seasonBestText !== undefined)
		return row.seasonBestText
	if (row.seasonBest === null || row.seasonBest === undefined) return null
	return Number(row.seasonBest)
}
