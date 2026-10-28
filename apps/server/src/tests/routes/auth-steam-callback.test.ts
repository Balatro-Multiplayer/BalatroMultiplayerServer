import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock('../../features/auth/steam.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../features/auth/steam.js')>()),
	validateSteamOpenIdResponse: vi.fn(async () => ok('76561198000000001')),
	getSteamPlayerName: vi.fn(async () => 'Alice'),
}))

const app = createTestApp()
const mutableEnv = env as { NOTICE_REQUIRED: boolean }
const originalNoticeRequired = env.NOTICE_REQUIRED

afterEach(() => {
	mutableEnv.NOTICE_REQUIRED = originalNoticeRequired
})

describe('GET /api/auth/steam/web/callback', () => {
	it('sends a player who has not accepted the Notice to the Notice page on the Official server', async () => {
		mutableEnv.NOTICE_REQUIRED = true
		const res = await request(app).get('/api/auth/steam/web/callback')
		expect(res.status).toBe(302)
		expect(res.headers.location).toContain('/auth/tos?token=')
	})

	it('logs the player in without the Notice on a server kind that does not ask for it', async () => {
		mutableEnv.NOTICE_REQUIRED = false
		const res = await request(app).get('/api/auth/steam/web/callback')
		expect(res.status).toBe(302)
		expect(res.headers.location).toContain('/auth/callback?token=')
	})
})
