import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPinProxyZip } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'
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
	findPinProxyZip: vi.fn(),
}))

const app = createTestApp()
const NAME = 'BalatroMultiplayer-MultiplayerAPI-1.2.3.zip'
const URL_PATH = `/api/mods/MultiplayerAPI/pin-proxy/1.2.3/${NAME}`
const BYTES = Buffer.from('PK\x03\x04-fake-zip-bytes')
const SHA = createHash('sha256').update(BYTES).digest('hex')

beforeEach(() => {
	vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue({
		id: 'MultiplayerAPI',
	} as never)
	vi.mocked(findPinProxyZip).mockResolvedValue({
		assetName: NAME,
		zipBytes: BYTES,
		zipSha256: SHA,
	})
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/mods/:id/pin-proxy/:version/:file', () => {
	it('serves the stored bytes with zip headers and an ETag from the hash', async () => {
		const res = await request(app).get(URL_PATH).buffer(true).parse(binary)

		expect(res.status).toBe(200)
		expect(Buffer.from(res.body).equals(BYTES)).toBe(true)
		expect(res.headers['content-type']).toBe('application/zip')
		expect(res.headers['content-disposition']).toBe(
			`attachment; filename="${NAME}"`,
		)
		expect(res.headers['content-length']).toBe(String(BYTES.length))
		expect(res.headers.etag).toBe(`"${SHA}"`)
		expect(res.headers['cache-control']).toContain('public')
		expect(res.headers['cache-control']).toContain('max-age')
		expect(findPinProxyZip).toHaveBeenCalledWith('MultiplayerAPI', '1.2.3')
	})

	it('answers HEAD with the same headers and no body', async () => {
		const res = await request(app).head(URL_PATH)
		expect(res.status).toBe(200)
		expect(res.headers['content-length']).toBe(String(BYTES.length))
		expect(res.headers.etag).toBe(`"${SHA}"`)
		expect(res.text ?? '').toBe('')
	})

	it('answers 304 when the ETag matches', async () => {
		const res = await request(app)
			.get(URL_PATH)
			.set('If-None-Match', `"${SHA}"`)
		expect(res.status).toBe(304)
	})

	it('answers 404 when no switch row has bytes, or the file name differs', async () => {
		vi.mocked(findPinProxyZip).mockResolvedValueOnce(null)
		expect((await request(app).get(URL_PATH)).status).toBe(404)
		const other = await request(app).get(
			'/api/mods/MultiplayerAPI/pin-proxy/1.2.3/Other.zip',
		)
		expect(other.status).toBe(404)
	})

	it('answers 404 for an unknown mod', async () => {
		vi.mocked(modsGateway.findModByIdOrFullName).mockResolvedValue(null)
		expect((await request(app).get(URL_PATH)).status).toBe(404)
		expect(findPinProxyZip).not.toHaveBeenCalled()
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
