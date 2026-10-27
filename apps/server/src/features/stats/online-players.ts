import type { Result } from '../../shared/utils/result.js'

// Online players for the Stats page: every account whose game holds a socket
// to Nakama now. A website login holds no socket, and session.single_socket
// allows one per account, so Nakama's open-socket gauge (nakama_sessions on
// its Prometheus endpoint) is the count.

// One sample line: the metric name, optional {labels}, then the value.
const SESSIONS_LINE = /^nakama_sessions(?:\{[^}]*\})?\s+(\S+)/

// The gauge has one line per Nakama node; the sum is the server's count.
// null: no line for the gauge, so the count is unknown.
export function parseNakamaSessions(body: string): number | null {
	let total: number | null = null
	for (const line of body.split('\n')) {
		const match = SESSIONS_LINE.exec(line)
		if (!match) continue
		const value = Number(match[1])
		if (!Number.isFinite(value)) continue
		total = (total ?? 0) + value
	}
	return total
}

export type FetchMetrics = () => Promise<Result<string, unknown>>

// Every visitor polls the page, so the count is cached briefly: at most one
// metrics fetch per ttl. The pending promise is cached too, so requests that
// arrive during a fetch share it. null: Nakama or its metrics are down.
export function createOnlinePlayers(fetchMetrics: FetchMetrics, ttlMs: number) {
	let cached: Promise<number | null> | null = null
	let cachedAt = 0

	async function load(): Promise<number | null> {
		const answer = await fetchMetrics()
		return answer.ok ? parseNakamaSessions(answer.value) : null
	}

	return function getOnlinePlayers(now: number): Promise<number | null> {
		if (!cached || now - cachedAt >= ttlMs) {
			cached = load()
			cachedAt = now
		}
		return cached
	}
}
