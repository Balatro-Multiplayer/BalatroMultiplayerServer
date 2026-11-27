import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { inspectModArchive } from '../../features/mods/mod-version-hash.js'
import {
	hasThunderstoreVersion,
	upsertPinProxySwitch,
} from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
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
	inspectModArchive: vi.fn(),
}))

const app = createTestApp()
const original = env.MOD_PIN_PROXY_TOKEN
const TOKEN = 'pin-proxy-token-123'
const ZIP = Buffer.from('PK\x03\x04 zip bytes')
const query = { mod: 'MultiplayerAPI', version: '1.2.3' }

const call = (
	token?: string,
	params: Record<string, string> = query,
	payload: Buffer = ZIP,
	type = 'application/zip',
) => {
	const req = request(app)
		.post('/api/ci/ranked-pin-proxy')
		.query(params)
		.set('Content-Type', type)
	return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
		payload,
	)
}

beforeEach(() => {
	vi.mocked(hasThunderstoreVersion).mockReset().mockResolvedValue(false)
	vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
		id: 'MultiplayerAPI',
		thunderstoreFullName: 'BalatroMultiplayer-MultiplayerAPI',
		rankedVersion: '1.2.2',
	} as never)
	vi.mocked(inspectModArchive).mockResolvedValue({
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
			.set('Content-Type', 'application/zip')
			.query(query)
			.send(ZIP)
		expect(blank.status).toBe(404)
		expect(inspectModArchive).not.toHaveBeenCalled()
	})

	it('refuses a missing, wrong or different-length token and changes nothing', async () => {
		expect((await call()).status).toBe(401)
		expect((await call('pin-proxy-token-124')).status).toBe(403)
		expect((await call('x')).status).toBe(403)
		expect(inspectModArchive).not.toHaveBeenCalled()
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
			downloadUrl: `${env.WEB_BASE_URL}/api/mods/MultiplayerAPI/pin-proxy/1.2.3/BalatroMultiplayer-MultiplayerAPI-1.2.3.zip`,
		})
		expect(inspectModArchive).toHaveBeenCalledWith(
			'MultiplayerAPI',
			'1.2.3',
			expect.any(Buffer),
			'thunderstore',
		)
		expect(modsGateway.storeRankedPin).toHaveBeenCalledWith(
			'MultiplayerAPI',
			expect.objectContaining({ version: '1.2.3', source: 'thunderstore' }),
		)
		expect(upsertPinProxySwitch).toHaveBeenCalledTimes(1)
		const started = vi.mocked(upsertPinProxySwitch).mock.calls[0]?.[0]
		expect(Buffer.from(started?.zipBytes ?? []).equals(ZIP)).toBe(true)
		expect(started?.zipSha256).toBe(
			createHash('sha256').update(ZIP).digest('hex'),
		)
		expect(recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: 'mod_pin' }),
		)
	})

	it('refuses a mod that is not on the allowlist', async () => {
		vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
			id: 'MultiplayerPvP',
			thunderstoreFullName: 'BalatroMultiplayer-MultiplayerAPI',
			rankedVersion: null,
		} as never)
		const res = await call(TOKEN, { ...query, mod: 'MultiplayerPvP' })
		expect(res.status).toBe(403)
		expect(modsGateway.storeRankedPin).not.toHaveBeenCalled()
	})

	it('refuses an empty body and a body that is not a zip, and fetches nothing', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		expect((await call(TOKEN, query, Buffer.alloc(0))).status).toBe(400)
		expect(
			(await call(TOKEN, query, Buffer.from('<html>not a zip</html>'))).status,
		).toBe(400)
		const wrongType = await call(TOKEN, query, ZIP, 'application/json')
		expect(wrongType.status).toBe(400)
		expect(inspectModArchive).not.toHaveBeenCalled()
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})

	it('refuses a body over 50 MB', async () => {
		const big = Buffer.alloc(50 * 1024 * 1024 + 1024)
		big.write('PK\x03\x04')
		const res = await call(TOKEN, query, big)
		expect(res.status).toBe(413)
		expect(inspectModArchive).not.toHaveBeenCalled()
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
	})

	it('asks for the mod and the version', async () => {
		for (const missing of ['mod', 'version']) {
			const params: Record<string, string> = { ...query }
			delete params[missing]
			expect((await call(TOKEN, params)).status).toBe(400)
		}
	})

	it('refuses a version that is not x.y.z', async () => {
		expect((await call(TOKEN, { ...query, version: 'v1' })).status).toBe(400)
		expect(inspectModArchive).not.toHaveBeenCalled()
	})

	it('serves through the proxy when forceProxy=true, even if Thunderstore lists the version', async () => {
		vi.mocked(hasThunderstoreVersion).mockResolvedValueOnce(true)
		const res = await call(TOKEN, { ...query, forceProxy: 'true' })
		expect(res.status).toBe(200)
		expect(res.body.mode).toBe('proxy')
		expect(upsertPinProxySwitch).toHaveBeenCalledTimes(1)
	})

	it('pins the normal way when Thunderstore already lists the version', async () => {
		vi.mocked(hasThunderstoreVersion).mockResolvedValueOnce(true)
		vi.mocked(modsGateway.setRankedVersion).mockResolvedValueOnce({
			ok: true,
		} as never)
		const res = await call(TOKEN)
		expect(res.status).toBe(200)
		expect(res.body.mode).toBe('thunderstore')
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
	})

	it('answers 502 and changes nothing when the zip cannot be hashed', async () => {
		vi.mocked(inspectModArchive).mockResolvedValue(null)
		expect((await call(TOKEN)).status).toBe(502)
		expect(modsGateway.storeRankedPin).not.toHaveBeenCalled()
		expect(upsertPinProxySwitch).not.toHaveBeenCalled()
	})
})
