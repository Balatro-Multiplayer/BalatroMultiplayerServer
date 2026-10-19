// A whole number from a query-string value, clamped to [min, max]. Anything
// that isn't one finite number (missing, '', 'abc', an array from
// `?x=1&x=2`, 1e400) gives the fallback. A bare Number(...) clamp passed NaN
// through: `Math.min(100, Math.max(1, NaN))` is NaN, and drizzle's
// `.limit(NaN)` drops the LIMIT, so `?limit=abc` read the whole table.
export function queryInt(raw: unknown, fallback: number, min: number, max: number): number {
	if (typeof raw !== 'string' || raw.trim() === '') return fallback
	const n = Number(raw)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.trunc(n)))
}

// The highest page a list route serves; keeps (page - 1) * pageSize a safe
// integer and the OFFSET inside Postgres's bigint.
export const MAX_PAGE = 1_000_000
