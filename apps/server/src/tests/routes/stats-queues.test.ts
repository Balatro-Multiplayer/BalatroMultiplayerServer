import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminClient from '../../infrastructure/nakama/admin-client.js'
import { err, ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock(
	'../../infrastructure/nakama/admin-client.js',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('../../infrastructure/nakama/admin-client.js')
		>()),
		callNakamaRpc: vi.fn(),
	}),
)

const app = createTestApp()
const callNakamaRpc = vi.mocked(adminClient.callNakamaRpc)

const pvpCounts = {
	modId: 'MultiplayerPvP',
	gameModes: { 'ranked:pvp_ranked_balanced': { queued: 1, inMatch: 2 } },
}
const spdrnCounts = {
	modId: 'MultiplayerSPDRN',
	gameModes: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
}

function answerBothMods() {
	callNakamaRpc.mockImplementation(async (_id, body) =>
		ok(body.modId === 'MultiplayerPvP' ? pvpCounts : spdrnCounts),
	)
}

// The route keeps its cache between tests; move the clock past it each time.
let clock = Date.UTC(2026, 9, 27)
beforeEach(() => {
	clock += 60_000
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(clock)
	callNakamaRpc.mockReset()
})
afterAll(() => {
	vi.useRealTimers()
})

describe('GET /api/stats/queues', () => {
	it('answers the live counts of PvP and Speedrunning from queue_counts', async () => {
		answerBothMods()

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			MultiplayerPvP: {
				'ranked:pvp_ranked_balanced': { queued: 1, inMatch: 2 },
			},
			MultiplayerSPDRN: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
		})
		expect(callNakamaRpc).toHaveBeenCalledWith('queue_counts', {
			modId: 'MultiplayerPvP',
		})
		expect(callNakamaRpc).toHaveBeenCalledWith('queue_counts', {
			modId: 'MultiplayerSPDRN',
		})
	})

	it('asks Nakama at most once per mod in 10 seconds', async () => {
		answerBothMods()

		await request(app).get('/api/stats/queues')
		vi.setSystemTime(clock + 9_000)
		await request(app).get('/api/stats/queues')

		expect(callNakamaRpc).toHaveBeenCalledTimes(2)

		vi.setSystemTime(clock + 10_000)
		await request(app).get('/api/stats/queues')

		expect(callNakamaRpc).toHaveBeenCalledTimes(4)
	})

	it('answers null for a mod when Nakama does not answer', async () => {
		callNakamaRpc.mockImplementation(async (_id, body) =>
			body.modId === 'MultiplayerPvP' ? err('unreachable') : ok(spdrnCounts),
		)

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			MultiplayerPvP: null,
			MultiplayerSPDRN: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
		})
	})

	it('answers null for both mods when Nakama is not set up', async () => {
		callNakamaRpc.mockResolvedValue(err('disabled'))

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ MultiplayerPvP: null, MultiplayerSPDRN: null })
	})
})
