import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../../env.js'
import { createTestApp } from './app.js'

const app = createTestApp()
const original = env.INTERNAL_API_KEY

describe('/internal/nakama', () => {
	afterEach(() => {
		env.INTERNAL_API_KEY = original
	})

	it('refuses everything while no key is configured', async () => {
		env.INTERNAL_API_KEY = ''
		const res = await request(app).post('/internal/nakama/ping').set('X-BMP-Internal-Key', '')
		expect(res.status).toBe(401)
	})

	it('refuses a missing or wrong key', async () => {
		env.INTERNAL_API_KEY = 'secret-key'
		expect((await request(app).post('/internal/nakama/ping')).status).toBe(401)
		const wrong = await request(app).post('/internal/nakama/ping').set('X-BMP-Internal-Key', 'secret-kez')
		expect(wrong.status).toBe(403)
		const short = await request(app).post('/internal/nakama/ping').set('X-BMP-Internal-Key', 'x')
		expect(short.status).toBe(403)
	})

	it('answers with the right key', async () => {
		env.INTERNAL_API_KEY = 'secret-key'
		const res = await request(app).post('/internal/nakama/ping').set('X-BMP-Internal-Key', 'secret-key')
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ ok: true })
	})
})
