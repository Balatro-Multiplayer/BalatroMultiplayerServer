import type { FetchMetrics } from '../../contracts/IStatsSources.js'
import { createTtlCache } from '../../shared/utils/ttl-cache.js'

// Online players for the Stats page: every account whose game holds a socket
// to Nakama now. A website login holds no socket, and session.single_socket
// allows one per account, so Nakama's open-socket gauge (nakama_sessions on
// its Prometheus endpoint) is the count.

// One sample line: the metric name, optional {labels}, then the value.
const SESSIONS_LINE = /^nakama_sessions(?:\{[^}]*\})?\s+(\S+)/

// The gauge has one line per Nakama node; the sum is the server's count.
// Nakama adds the gauge only when the first socket opens after a start, so
// no line means nobody is online.
export function parseNakamaSessions(body: string): number {
	let total = 0
	for (const line of body.split('\n')) {
		const match = SESSIONS_LINE.exec(line)
		if (!match) continue
		const value = Number(match[1])
		if (!Number.isFinite(value)) continue
		total += value
	}
	return total
}

// Every visitor polls the page, so the count is cached: at most one metrics
// fetch per ttl. null: Nakama or its metrics are down.
export function createOnlinePlayers(fetchMetrics: FetchMetrics, ttlMs: number) {
	return createTtlCache(async (): Promise<number | null> => {
		const answer = await fetchMetrics()
		return answer.ok ? parseNakamaSessions(answer.value) : null
	}, ttlMs)
}
