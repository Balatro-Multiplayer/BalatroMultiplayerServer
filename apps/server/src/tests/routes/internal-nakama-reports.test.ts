import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import * as reportGateway from '../../infrastructure/gateways/report.gateway.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/gateways/report.gateway.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../infrastructure/gateways/report.gateway.js')>()),
	submitNakamaReport: vi.fn(),
}))

const app = createTestApp()
const original = env.INTERNAL_API_KEY
const KEY = 'secret-key'
const ME = '11111111-1111-4111-8111-111111111111'
const THEM = '22222222-2222-4222-8222-222222222222'
const LOBBY = '33333333-3333-4333-8333-333333333333'

const body = (over: object = {}) => ({
	reporterId: ME,
	reportedId: THEM,
	type: 'chat_abuse',
	message: 'mean',
	lobbyId: LOBBY,
	lobbyCode: 'ABC123',
	runId: null,
	chat: [{ playerId: THEM, displayName: 'Them', message: 'rude', sentAt: 1000 }],
	...over,
})

describe('/internal/nakama/reports', () => {
	beforeEach(() => {
		env.INTERNAL_API_KEY = KEY
		vi.mocked(reportGateway.submitNakamaReport).mockResolvedValue(7)
	})
	afterEach(() => {
		env.INTERNAL_API_KEY = original
	})

	it('files the report under the players\' ids', async () => {
		vi.mocked(playerGateway.findPlayerIdsByNakamaUserIds).mockResolvedValueOnce(
			new Map([
				[ME, 'player-me'],
				[THEM, 'player-them'],
			]),
		)
		const res = await request(app).post('/internal/nakama/reports').set('X-BMP-Internal-Key', KEY).send(body())
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ ok: true, reportId: 7 })
		expect(reportGateway.submitNakamaReport).toHaveBeenCalledWith({
			lobbyId: LOBBY,
			lobbyCode: 'ABC123',
			reporterId: 'player-me',
			reportedId: 'player-them',
			type: 'chat_abuse',
			runId: null,
			message: 'mean',
			chat: [{ playerId: 'player-them', displayName: 'Them', message: 'rude', sentAt: new Date(1000) }],
		})
	})

	it('keeps the Nakama id of a player with no player row', async () => {
		const res = await request(app).post('/internal/nakama/reports').set('X-BMP-Internal-Key', KEY).send(body({ chat: [] }))
		expect(res.status).toBe(200)
		expect(reportGateway.submitNakamaReport).toHaveBeenCalledWith(
			expect.objectContaining({ reporterId: ME, reportedId: THEM, chat: [] }),
		)
	})

	it('refuses a malformed report', async () => {
		for (const bad of [
			body({ type: 'spam' }),
			body({ reportedId: 'x' }),
			body({ message: 'x'.repeat(501) }),
			body({ lobbyCode: 'TOOLONG1' }),
			body({ runId: 'not-a-uuid' }),
			body({ chat: [{ playerId: THEM }] }),
		]) {
			const res = await request(app).post('/internal/nakama/reports').set('X-BMP-Internal-Key', KEY).send(bad)
			expect(res.status).toBe(400)
		}
		expect(reportGateway.submitNakamaReport).not.toHaveBeenCalled()
	})

	it('needs the internal key', async () => {
		const res = await request(app).post('/internal/nakama/reports').send(body())
		expect(res.status).toBe(401)
	})
})
