import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import { err, ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/nakama/admin-client.js', () => ({
	callNakamaRpc: vi.fn(),
	isNakamaAdminEnabled: vi.fn().mockReturnValue(true),
}))

const app = createTestApp()
const original = env.DEPLOY_TOKEN
const TOKEN = 'deploy-token-123'
const body = { text: 'Ranked is closed for a server update.', reason: 'Full deploy' }

const announce = (token?: string, payload: unknown = body) => {
	const req = request(app).post('/api/deploy/announce')
	return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
		payload as object,
	)
}

afterEach(() => {
	env.DEPLOY_TOKEN = original
	vi.clearAllMocks()
})

describe('POST /api/deploy/announce', () => {
	it('refuses without the deploy token and sends nothing', async () => {
		env.DEPLOY_TOKEN = ''
		expect((await announce(TOKEN)).status).toBe(404)
		env.DEPLOY_TOKEN = TOKEN
		expect((await announce()).status).toBe(401)
		expect((await announce('wrong-token-1234')).status).toBe(403)
		expect(callNakamaRpc).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('sends the text through admin_announce and logs it as deploy', async () => {
		env.DEPLOY_TOKEN = TOKEN
		vi.mocked(callNakamaRpc).mockResolvedValue(ok({ ok: true }))
		const res = await announce(TOKEN)
		expect(res.status).toBe(200)
		expect(callNakamaRpc).toHaveBeenCalledWith('admin_announce', {
			text: body.text,
		})
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: expect.objectContaining({ role: 'deploy' }),
				action: 'announcement',
				reason: 'Full deploy',
				detail: { text: body.text },
			}),
		)
	})

	it('needs a text within the limit and a reason', async () => {
		env.DEPLOY_TOKEN = TOKEN
		for (const bad of [
			{ ...body, text: ' ' },
			{ ...body, text: 7 },
			{ ...body, text: 'x'.repeat(301) },
			{ ...body, reason: '' },
			{ text: body.text },
		]) {
			expect((await announce(TOKEN, bad)).status).toBe(400)
		}
		expect(callNakamaRpc).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('answers 502 and logs nothing when Nakama cannot send it', async () => {
		env.DEPLOY_TOKEN = TOKEN
		vi.mocked(callNakamaRpc).mockResolvedValue(err('unreachable'))
		const res = await announce(TOKEN)
		expect(res.status).toBe(502)
		expect(recordStaffAction).not.toHaveBeenCalled()
	})
})
