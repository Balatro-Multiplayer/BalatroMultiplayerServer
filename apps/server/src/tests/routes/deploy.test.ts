import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import * as modsGateway from '../../infrastructure/gateways/mods.gateway.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import { createTestApp } from './app.js'

vi.mock(
	'../../infrastructure/gateways/config.gateway.js',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		loadConfigFromDb: vi.fn().mockResolvedValue(undefined),
	}),
)
vi.mock(
	'../../infrastructure/gateways/mods.gateway.js',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		findModByIdOrFullName: vi.fn(),
		setRankedVersion: vi.fn(),
	}),
)

const app = createTestApp()
const original = env.DEPLOY_TOKEN
const TOKEN = 'deploy-token-123'
const PACKAGE = 'BalatroMultiplayer-MultiplayerPvP'
const body = {
	package: PACKAGE,
	version: '1.2.3',
	reason: 'Thunderstore publish 1.2.3',
}

const pin = (token?: string, payload: unknown = body) => {
	const req = request(app).put('/api/deploy/pins')
	return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
		payload as object,
	)
}

beforeEach(() => {
	vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
		id: 'mod-1',
		rankedVersion: '1.2.2',
	} as any)
	vi.mocked(modsGateway.setRankedVersion).mockResolvedValue({ ok: true })
})
afterEach(() => {
	env.DEPLOY_TOKEN = original
	vi.clearAllMocks()
})

describe('/api/deploy token check', () => {
	it('refuses every call while no DEPLOY_TOKEN is set, even a blank bearer', async () => {
		env.DEPLOY_TOKEN = ''
		expect((await pin(TOKEN)).status).toBe(404)
		const blank = await request(app)
			.put('/api/deploy/pins')
			.set('Authorization', 'Bearer ')
			.send(body)
		expect(blank.status).toBe(404)
		expect(modsGateway.setRankedVersion).not.toHaveBeenCalled()
	})

	it('refuses a missing, wrong, or different-length token and changes nothing', async () => {
		env.DEPLOY_TOKEN = TOKEN
		expect((await pin()).status).toBe(401)
		expect((await pin('deploy-token-124')).status).toBe(403)
		expect((await pin('x')).status).toBe(403)
		expect(modsGateway.setRankedVersion).not.toHaveBeenCalled()
		expect(loadConfigFromDb).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})
})

describe('PUT /api/deploy/pins', () => {
	it('pins the package, pushes the config and logs it as deploy', async () => {
		env.DEPLOY_TOKEN = TOKEN
		const res = await pin(TOKEN)
		expect(res.status).toBe(200)
		expect(modsGateway.findModByIdOrFullName).toHaveBeenCalledWith(PACKAGE)
		expect(modsGateway.setRankedVersion).toHaveBeenCalledWith('mod-1', '1.2.3')
		expect(loadConfigFromDb).toHaveBeenCalled()
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: expect.objectContaining({ role: 'deploy' }),
				action: 'mod_pin',
				reason: 'Thunderstore publish 1.2.3',
				detail: expect.objectContaining({
					modId: 'mod-1',
					old: { rankedVersion: '1.2.2' },
					new: { rankedVersion: '1.2.3' },
				}),
			}),
		)
	})

	it('answers 404 for an unknown package and changes nothing', async () => {
		env.DEPLOY_TOKEN = TOKEN
		vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue(null)
		const res = await pin(TOKEN)
		expect(res.status).toBe(404)
		expect(modsGateway.setRankedVersion).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('answers 400 for a version Thunderstore does not have and logs nothing', async () => {
		env.DEPLOY_TOKEN = TOKEN
		vi.mocked(modsGateway.setRankedVersion).mockResolvedValue({
			ok: false,
			reason: 'version-not-found',
		})
		const res = await pin(TOKEN)
		expect(res.status).toBe(400)
		expect(res.body.error).toMatch(/version/i)
		expect(loadConfigFromDb).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('needs package, version and reason', async () => {
		env.DEPLOY_TOKEN = TOKEN
		for (const bad of [
			{ ...body, package: '' },
			{ ...body, version: undefined },
			{ ...body, version: null },
			{ ...body, reason: ' ' },
		]) {
			expect((await pin(TOKEN, bad)).status).toBe(400)
		}
		expect(modsGateway.setRankedVersion).not.toHaveBeenCalled()
	})
})
