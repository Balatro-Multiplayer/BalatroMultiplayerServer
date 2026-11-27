import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPinProxySwitch } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
import * as modsGateway from '../../infrastructure/gateways/mods.gateway.js'
import { createTestApp } from './app.js'

vi.mock(
	'../../infrastructure/gateways/mods.gateway.js',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		findModByIdOrFullName: vi.fn(),
	}),
)
vi.mock('../../infrastructure/gateways/mod-pin-proxy.gateway.js', () => ({
	findPinProxySwitch: vi.fn(),
}))

const app = createTestApp()
const ASSET =
	'https://github.com/Balatro-Multiplayer/BalatroMultiplayerAPI/releases/download/v1.2.3/MultiplayerAPI-1.2.3.zip'
const URL_PATH =
	'/api/mods/MultiplayerAPI/pin-proxy/1.2.3/MultiplayerAPI-1.2.3.zip'
const BYTES = Buffer.from('PK-fake-zip-bytes')

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
	vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
		id: 'MultiplayerAPI',
	} as never)
	vi.mocked(findPinProxySwitch).mockResolvedValue({
		modId: 'MultiplayerAPI',
		version: '1.2.3',
		assetName: 'MultiplayerAPI-1.2.3.zip',
		assetUrl: ASSET,
	} as never)
	fetchMock = vi.fn(
		async (_url: string, init?: { method?: string }) =>
			new Response(init?.method === 'HEAD' ? null : BYTES, {
				status: 200,
				headers: { 'content-length': String(BYTES.length) },
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('GET /api/mods/:id/pin-proxy/:version/:file', () => {
	it('streams the stored GitHub asset with zip headers', async () => {
		const res = await request(app).get(URL_PATH).buffer(true).parse(binary)

		expect(res.status).toBe(200)
		expect(Buffer.from(res.body).equals(BYTES)).toBe(true)
		expect(res.headers['content-type']).toBe('application/zip')
		expect(res.headers['content-disposition']).toBe(
			'attachment; filename="MultiplayerAPI-1.2.3.zip"',
		)
		expect(res.headers['content-length']).toBe(String(BYTES.length))
		expect(res.headers['cache-control']).toContain('max-age')
		// The URL fetched is the stored one, never anything from the request.
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe(ASSET)
	})

	it('answers HEAD without a body', async () => {
		const res = await request(app).head(URL_PATH)
		expect(res.status).toBe(200)
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
	})

	it('answers 404 for a version or file the switch does not name', async () => {
		vi.mocked(findPinProxySwitch).mockResolvedValueOnce(null)
		expect((await request(app).get(URL_PATH)).status).toBe(404)
		const other = await request(app).get(
			'/api/mods/MultiplayerAPI/pin-proxy/1.2.3/Other.zip',
		)
		expect(other.status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('answers 404 for an unknown mod', async () => {
		vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue(null)
		expect((await request(app).get(URL_PATH)).status).toBe(404)
	})

	it('maps a gone asset to 404 and other source trouble to 502', async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
		expect((await request(app).get(URL_PATH)).status).toBe(404)
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
		expect((await request(app).get(URL_PATH)).status).toBe(502)
		fetchMock.mockRejectedValueOnce(new Error('network down'))
		expect((await request(app).get(URL_PATH)).status).toBe(502)
	})
})

function binary(
	res: NodeJS.ReadableStream,
	callback: (err: Error | null, body: Buffer) => void,
) {
	const chunks: Buffer[] = []
	res.on('data', (c: Buffer) => chunks.push(c))
	res.on('end', () => callback(null, Buffer.concat(chunks)))
}
