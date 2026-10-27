import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchMetrics } from '../../contracts/IStatsSources.js'
import { err, ok } from '../../shared/utils/result.js'
import { createStatsTestApp } from './stats-app.js'

function metricsWithSessions(count: number) {
	return ok(
		`# TYPE nakama_sessions gauge\nnakama_sessions{node_name="nakama1"} ${count}\n`,
	)
}

const clock = Date.UTC(2026, 9, 27)
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(clock)
})
afterEach(() => {
	vi.useRealTimers()
})

function appWithMetrics(fetchMetrics: FetchMetrics) {
	return createStatsTestApp({ fetchMetrics: vi.fn(fetchMetrics) })
}

describe('GET /api/stats online players', () => {
	it('answers the open Nakama sessions as onlinePlayers', async () => {
		const { app } = appWithMetrics(async () => metricsWithSessions(2))

		const res = await request(app).get('/api/stats')

		expect(res.status).toBe(200)
		expect(res.body.onlinePlayers).toBe(2)
		expect(res.body).not.toHaveProperty('activePlayers')
		expect(res.body).toHaveProperty('totalMatches')
		expect(res.body).toHaveProperty('uniquePlayers')
	})

	it.each([
		['Nakama does not answer', err('unreachable' as const)],
		['the metrics URL is not set', err('disabled' as const)],
	])('answers onlinePlayers null when %s', async (_case, answer) => {
		const { app } = appWithMetrics(async () => answer)

		const res = await request(app).get('/api/stats')

		expect(res.status).toBe(200)
		expect(res.body.onlinePlayers).toBeNull()
		expect(res.body).toHaveProperty('totalMatches')
	})

	// After a Nakama start the gauge appears only when the first socket opens.
	it('answers onlinePlayers 0 when the metrics answer without the gauge', async () => {
		const { app } = appWithMetrics(async () =>
			ok('# TYPE nakama_api_count counter\n'),
		)

		const res = await request(app).get('/api/stats')

		expect(res.status).toBe(200)
		expect(res.body.onlinePlayers).toBe(0)
	})

	it('refreshes the online count after 10 seconds while the totals stay cached', async () => {
		const fetchMetrics = vi
			.fn<FetchMetrics>()
			.mockResolvedValueOnce(metricsWithSessions(2))
			.mockResolvedValueOnce(metricsWithSessions(1))
		const { app, sources } = createStatsTestApp({ fetchMetrics })

		await request(app).get('/api/stats')
		vi.setSystemTime(clock + 9_000)
		const cached = await request(app).get('/api/stats')

		expect(cached.body.onlinePlayers).toBe(2)
		expect(fetchMetrics).toHaveBeenCalledTimes(1)

		vi.setSystemTime(clock + 10_000)
		const refreshed = await request(app).get('/api/stats')

		expect(refreshed.body.onlinePlayers).toBe(1)
		expect(fetchMetrics).toHaveBeenCalledTimes(2)
		expect(sources.statsRepository.countTotals).toHaveBeenCalledTimes(1)
	})
})
