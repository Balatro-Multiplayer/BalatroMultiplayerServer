import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../../infrastructure/db/index.js'
import { createTestApp } from './app.js'

const app = createTestApp()

// The shared db mock has no execute(); the raw-SQL stats routes need one.
Object.assign(db, { execute: vi.fn().mockResolvedValue({ rows: [] }) })

describe('removed Stats page routes', () => {
	it.each([
		'/api/stats/history',
		'/api/stats/stake-popularity',
		'/api/stats/season-overview',
	])('%s answers 404', async (path) => {
		const res = await request(app).get(path)

		expect(res.status).toBe(404)
	})
})

describe('kept stats routes', () => {
	it('GET /api/stats answers the counters', async () => {
		const res = await request(app).get('/api/stats')

		expect(res.status).toBe(200)
		expect(res.body).toHaveProperty('totalMatches')
		expect(res.body).toHaveProperty('uniquePlayers')
	})

	it('GET /api/stats/activity answers the hourly buckets', async () => {
		const res = await request(app).get('/api/stats/activity')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ buckets: [] })
	})

	it('GET /api/stats/seasons answers the season list for the Leaderboards page', async () => {
		const res = await request(app).get('/api/stats/seasons')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ seasons: [], current: null })
	})

	it('GET /api/stats/leaderboard answers a board for the Leaderboards page', async () => {
		const res = await request(app).get(
			'/api/stats/leaderboard?modId=MultiplayerPvP&gameMode=ranked&season=1',
		)

		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({ season: 1, total: 0, entries: [] })
	})

	it('GET /api/stats/players/:id is still routed for the Player page', async () => {
		const res = await request(app).get(
			'/api/stats/players/missing?modId=MultiplayerPvP&gameMode=ranked&season=1',
		)

		expect(res.status).toBe(404)
		expect(res.body.error ?? res.body.message).toMatch(/Player not found/)
	})
})
