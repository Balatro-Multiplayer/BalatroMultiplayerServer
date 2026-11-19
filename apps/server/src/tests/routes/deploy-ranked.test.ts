import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import {
	loadConfigFromDb,
	setRankedEnabled,
} from '../../infrastructure/gateways/config.gateway.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { err, ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock(
	'../../infrastructure/gateways/config.gateway.js',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		loadConfigFromDb: vi.fn().mockResolvedValue(undefined),
		setRankedEnabled: vi.fn().mockResolvedValue(undefined),
	}),
)
vi.mock('../../infrastructure/nakama/admin-client.js', async (importOriginal) => ({
	...(await importOriginal<object>()),
	callNakamaRpc: vi.fn(),
}))

const app = createTestApp()
const original = env.DEPLOY_TOKEN
const TOKEN = 'deploy-token-123'
const auth = { Authorization: `Bearer ${TOKEN}` }
const reason = { reason: 'Full deploy abc1234' }

beforeEach(() => {
	env.DEPLOY_TOKEN = TOKEN
})
afterEach(() => {
	env.DEPLOY_TOKEN = original
	vi.clearAllMocks()
})

describe('POST /api/deploy/ranked/close', () => {
	it('turns Ranked off, logs as deploy, then cancels the ranked queue', async () => {
		vi.mocked(callNakamaRpc).mockResolvedValue(ok({ cancelled: 3 }))
		const res = await request(app).post('/api/deploy/ranked/close').set(auth).send(reason)
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ ok: true, cancelled: 3 })
		expect(setRankedEnabled).toHaveBeenCalledWith(false)
		expect(loadConfigFromDb).toHaveBeenCalled()
		expect(callNakamaRpc).toHaveBeenCalledWith('admin_ranked_queue_cancel', expect.objectContaining({ reason: expect.any(String) }))
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: expect.objectContaining({ role: 'deploy' }),
				action: 'config_change',
				reason: reason.reason,
				detail: expect.objectContaining({ new: { rankedEnabled: false } }),
			}),
		)
	})

	it('refuses without a reason and changes nothing', async () => {
		const res = await request(app).post('/api/deploy/ranked/close').set(auth).send({})
		expect(res.status).toBe(400)
		expect(setRankedEnabled).not.toHaveBeenCalled()
		expect(callNakamaRpc).not.toHaveBeenCalled()
	})

	it('refuses without the token', async () => {
		const res = await request(app).post('/api/deploy/ranked/close').send(reason)
		expect(res.status).toBe(401)
		expect(setRankedEnabled).not.toHaveBeenCalled()
	})

	it('answers 502 when the queue cancel fails, after Ranked is already closed', async () => {
		vi.mocked(callNakamaRpc).mockResolvedValue(err('unreachable'))
		const res = await request(app).post('/api/deploy/ranked/close').set(auth).send(reason)
		expect(res.status).toBe(502)
		expect(setRankedEnabled).toHaveBeenCalledWith(false)
	})
})

describe('POST /api/deploy/ranked/open', () => {
	it('turns Ranked on and logs as deploy', async () => {
		const res = await request(app).post('/api/deploy/ranked/open').set(auth).send(reason)
		expect(res.status).toBe(200)
		expect(setRankedEnabled).toHaveBeenCalledWith(true)
		expect(loadConfigFromDb).toHaveBeenCalled()
		expect(callNakamaRpc).not.toHaveBeenCalled()
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: expect.objectContaining({ role: 'deploy' }),
				detail: expect.objectContaining({ new: { rankedEnabled: true } }),
			}),
		)
	})

	it('refuses without a reason', async () => {
		const res = await request(app).post('/api/deploy/ranked/open').set(auth).send({})
		expect(res.status).toBe(400)
		expect(setRankedEnabled).not.toHaveBeenCalled()
	})
})

describe('GET /api/deploy/ranked/live', () => {
	it('returns the running count from Nakama', async () => {
		vi.mocked(callNakamaRpc).mockResolvedValue(ok({ running: 137 }))
		const res = await request(app).get('/api/deploy/ranked/live').set(auth)
		expect(res.body).toEqual({ running: 137 })
		expect(callNakamaRpc).toHaveBeenCalledWith('admin_ranked_live', {})
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('answers 502 when Nakama is unreachable', async () => {
		vi.mocked(callNakamaRpc).mockResolvedValue(err('unreachable'))
		const res = await request(app).get('/api/deploy/ranked/live').set(auth)
		expect(res.status).toBe(502)
	})

	it('refuses with no DEPLOY_TOKEN set', async () => {
		env.DEPLOY_TOKEN = ''
		expect((await request(app).get('/api/deploy/ranked/live').set(auth)).status).toBe(404)
	})
})
