import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { inspectModRelease } from '../../features/mods/mod-version-hash.js'
import { upsertPinProxySwitch } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
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
		storeRankedPin: vi.fn().mockResolvedValue(undefined),
	}),
)
vi.mock('../../infrastructure/gateways/mod-pin-proxy.gateway.js', () => ({
	hasThunderstoreVersion: vi.fn().mockResolvedValue(false),
	upsertPinProxySwitch: vi.fn().mockResolvedValue(undefined),
	findPinProxySwitch: vi.fn(),
}))
vi.mock('../../features/mods/mod-version-hash.js', () => ({
	inspectModRelease: vi.fn(),
}))

const app = createTestApp()
const original = env.MOD_PIN_PROXY_TOKEN
const TOKEN = 'pin-proxy-token-123'
const REPO = 'https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI'
const ASSET = `${REPO}/releases/download/v1.2.3/MultiplayerAPI-1.2.3.zip`
const body = { mod: 'MultiplayerAPI', version: '1.2.3', assetUrl: ASSET }

const call = (token?: string, payload: unknown = body) => {
	const req = request(app).post('/api/ci/ranked-pin-proxy')
	return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
		payload as object,
	)
}

beforeEach(() => {
	vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
		id: 'MultiplayerAPI',
		repoUrl: REPO,
		rankedVersion: '1.2.2',
	} as never)
	vi.mocked(inspectModRelease).mockResolvedValue({
		hash: 'a'.repeat(64),
		fileHashes: {},
		smodsIds: ['MultiplayerAPI'],
	})
	env.MOD_PIN_PROXY_TOKEN = TOKEN
})
afterEach(() => {
	env.MOD_PIN_PROXY_TOKEN = original
	vi.clearAllMocks()
})

describe('/api/ci/ranked-pin-proxy auth', () => {
	it('answers 404 to every call while no token is set, even a blank bearer', async () => {
		env.MOD_PIN_PROXY_TOKEN = ''
		expect((await call(TOKEN)).status).toBe(404)
		const blank = await request(app)
			.post('/api/ci/ranked-pin-proxy')
			.set('Authorization', 'Bearer ')
			.send(body)
		expect(blank.status).toBe(404)
		expect(inspectModRelease).not.toHaveBeenCalled()
	})

	it('refuses a missing, wrong or different-length token and changes nothing', async () => {
		expect((await call()).status).toBe(401)
		expect((await call('pin-proxy-token-124')).status).toBe(403)
		expect((await call('x')).status).toBe(403)
		expect(inspectModRelease).not.toHaveBeenCalled()
		expect(modsGateway.storeRankedPin).not.toHaveBeenCalled()
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
		expect(recordStaffAction).not.toHaveBeenCalled()
	})

	it('does not open with the deploy token', async () => {
		const deploy = env.DEPLOY_TOKEN
		env.DEPLOY_TOKEN = 'deploy-token-123'
		expect((await call('deploy-token-123')).status).toBe(403)
		env.DEPLOY_TOKEN = deploy
	})
})

describe('/api/ci/ranked-pin-proxy pin', () => {
	it('pins through the proxy, starts the switch and logs it', async () => {
		const res = await call(TOKEN)

		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({
			ok: true,
			mode: 'proxy',
			downloadUrl: `${env.WEB_BASE_URL}/api/mods/MultiplayerAPI/pin-proxy/1.2.3/MultiplayerAPI-1.2.3.zip`,
		})
		expect(inspectModRelease).toHaveBeenCalledWith(
			'MultiplayerAPI',
			'1.2.3',
			ASSET,
			'thunderstore',
		)
		expect(modsGateway.storeRankedPin).toHaveBeenCalledWith(
			'MultiplayerAPI',
			expect.objectContaining({ version: '1.2.3', source: 'thunderstore' }),
		)
		expect(upsertPinProxySwitch).toHaveBeenCalledTimes(1)
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: 'mod_pin' }),
		)
	})

	it('refuses a mod that is not on the allowlist', async () => {
		vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
			id: 'MultiplayerPvP',
			repoUrl: REPO,
			rankedVersion: null,
		} as never)
		const res = await call(TOKEN, { ...body, mod: 'MultiplayerPvP' })
		expect(res.status).toBe(403)
		expect(modsGateway.storeRankedPin).not.toHaveBeenCalled()
	})

	it('never fetches an asset URL that is not a release of the mod repo', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		for (const assetUrl of [
			'https://evil.example/x.zip',
			'https://github.com/someone/else/releases/download/v1/x.zip',
			`${ASSET}?x=1`,
		]) {
			const res = await call(TOKEN, { ...body, assetUrl })
			expect(res.status).toBe(400)
		}
		expect(inspectModRelease).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})

	it('asks for every field', async () => {
		for (const missing of ['mod', 'version', 'assetUrl']) {
			const payload: Record<string, unknown> = { ...body }
			delete payload[missing]
			expect((await call(TOKEN, payload)).status).toBe(400)
		}
	})

	it('answers 502 and changes nothing when the asset cannot be hashed', async () => {
		vi.mocked(inspectModRelease).mockResolvedValue(null)
		expect((await call(TOKEN)).status).toBe(502)
		expect(modsGateway.storeRankedPin).not.toHaveBeenCalled()
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
	})
})
