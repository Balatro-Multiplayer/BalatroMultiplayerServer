import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchQueueCounts } from '../../contracts/IStatsSources.js'
import { err, ok } from '../../shared/utils/result.js'
import { createStatsTestApp } from './stats-app.js'

const pvpCounts = {
	modId: 'MultiplayerPvP',
	gameModes: { 'ranked:pvp_ranked_balanced': { queued: 1, inMatch: 2 } },
}
const spdrnCounts = {
	modId: 'MultiplayerSPDRN',
	gameModes: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
}

function appWithQueueCounts(answer: FetchQueueCounts) {
	const fetchQueueCounts = vi.fn(answer)
	const { app } = createStatsTestApp({ fetchQueueCounts })
	return { app, fetchQueueCounts }
}

const answerBothMods: FetchQueueCounts = async (modId) =>
	ok(modId === 'MultiplayerPvP' ? pvpCounts : spdrnCounts)

const clock = Date.UTC(2026, 9, 27)
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(clock)
})
afterEach(() => {
	vi.useRealTimers()
})

describe('GET /api/stats/queues', () => {
	it('answers the live counts of PvP and Speedrunning from queue_counts', async () => {
		const { app, fetchQueueCounts } = appWithQueueCounts(answerBothMods)

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			MultiplayerPvP: {
				'ranked:pvp_ranked_balanced': { queued: 1, inMatch: 2 },
			},
			MultiplayerSPDRN: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
		})
		expect(fetchQueueCounts).toHaveBeenCalledWith('MultiplayerPvP')
		expect(fetchQueueCounts).toHaveBeenCalledWith('MultiplayerSPDRN')
	})

	it('asks Nakama at most once per mod in 10 seconds', async () => {
		const { app, fetchQueueCounts } = appWithQueueCounts(answerBothMods)

		await request(app).get('/api/stats/queues')
		vi.setSystemTime(clock + 9_000)
		await request(app).get('/api/stats/queues')

		expect(fetchQueueCounts).toHaveBeenCalledTimes(2)

		vi.setSystemTime(clock + 10_000)
		await request(app).get('/api/stats/queues')

		expect(fetchQueueCounts).toHaveBeenCalledTimes(4)
	})

	it('answers null for a mod when Nakama does not answer', async () => {
		const { app } = appWithQueueCounts(async (modId) =>
			modId === 'MultiplayerPvP' ? err('unreachable') : ok(spdrnCounts),
		)

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			MultiplayerPvP: null,
			MultiplayerSPDRN: { spdrn_gold_stake_single: { queued: 0, inMatch: 4 } },
		})
	})

	it('answers null for both mods when Nakama is not set up', async () => {
		const { app } = appWithQueueCounts(async () => err('disabled'))

		const res = await request(app).get('/api/stats/queues')

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ MultiplayerPvP: null, MultiplayerSPDRN: null })
	})
})
