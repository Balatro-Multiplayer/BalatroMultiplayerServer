import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../infrastructure/db/index.js'
import * as metricsClient from '../../infrastructure/nakama/metrics-client.js'
import { err, ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/nakama/metrics-client.js', () => ({
	fetchNakamaMetrics: vi.fn(),
}))

const app = createTestApp()
const fetchNakamaMetrics = vi.mocked(metricsClient.fetchNakamaMetrics)

function metricsWithSessions(count: number) {
	return ok(
		`# TYPE nakama_sessions gauge\nnakama_sessions{node_name="nakama1"} ${count}\n`,
	)
}

// The route keeps its caches between tests; move the clock past both each time.
let clock = Date.UTC(2026, 9, 27)
beforeEach(() => {
	clock += 60 * 60_000
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(clock)
	fetchNakamaMetrics.mockReset()
	vi.mocked(db.select).mockClear()
})
afterAll(() => {
	vi.useRealTimers()
})

describe('GET /api/stats online players', () => {
	it('answers the open Nakama sessions as onlinePlayers', async () => {
		fetchNakamaMetrics.mockResolvedValue(metricsWithSessions(2))

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
		['the gauge is missing', ok('# TYPE nakama_api_count counter\n')],
	])('answers onlinePlayers null when %s', async (_case, answer) => {
		fetchNakamaMetrics.mockResolvedValue(answer)

		const res = await request(app).get('/api/stats')

		expect(res.status).toBe(200)
		expect(res.body.onlinePlayers).toBeNull()
		expect(res.body).toHaveProperty('totalMatches')
	})

	it('refreshes the online count after 10 seconds while the totals stay cached', async () => {
		fetchNakamaMetrics.mockResolvedValueOnce(metricsWithSessions(2))
		fetchNakamaMetrics.mockResolvedValueOnce(metricsWithSessions(1))

		await request(app).get('/api/stats')
		const selectsAfterFirst = vi.mocked(db.select).mock.calls.length
		vi.setSystemTime(clock + 9_000)
		const cached = await request(app).get('/api/stats')

		expect(cached.body.onlinePlayers).toBe(2)
		expect(fetchNakamaMetrics).toHaveBeenCalledTimes(1)

		vi.setSystemTime(clock + 10_000)
		const refreshed = await request(app).get('/api/stats')

		expect(refreshed.body.onlinePlayers).toBe(1)
		expect(fetchNakamaMetrics).toHaveBeenCalledTimes(2)
		expect(vi.mocked(db.select).mock.calls.length).toBe(selectsAfterFirst)
	})
})
