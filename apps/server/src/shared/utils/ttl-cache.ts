// Caches the answer of load for ttlMs. The pending promise is cached too, so
// calls that arrive during a load share it. A load that throws is not kept,
// so the next call tries again.
export function createTtlCache<T>(
	load: () => Promise<T>,
	ttlMs: number,
): (now: number) => Promise<T> {
	let cached: Promise<T> | null = null
	let cachedAt = 0

	return function get(now: number): Promise<T> {
		if (!cached || now - cachedAt >= ttlMs) {
			const pending = load()
			cached = pending
			cachedAt = now
			pending.catch(() => {
				if (cached === pending) cached = null
			})
		}
		return cached
	}
}
