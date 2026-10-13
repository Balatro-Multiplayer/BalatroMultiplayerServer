import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import * as discord from '../../features/auth/discord.js'
import * as adminClient from '../../infrastructure/nakama/admin-client.js'
import { err, ok } from '../../shared/utils/result.js'
import { createTestApp } from './app.js'

vi.mock('../../features/auth/discord.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../features/auth/discord.js')>()),
	validateDiscordCode: vi.fn(),
}))
vi.mock('../../infrastructure/nakama/admin-client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../infrastructure/nakama/admin-client.js')>()),
	callNakamaRpc: vi.fn(),
}))

const app = createTestApp()
const original = env.INTERNAL_API_KEY
const KEY = 'secret-key'
const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'

async function linkUrlState(): Promise<string> {
	const res = await request(app)
		.post('/internal/nakama/discord/link-url')
		.set('X-BMP-Internal-Key', KEY)
		.send({ nakamaUserId: NAKAMA_ID })
	expect(res.status).toBe(200)
	return new URL(res.body.url).searchParams.get('state')!
}

describe('Discord linking for Nakama players', () => {
	beforeEach(() => {
		env.INTERNAL_API_KEY = KEY
		vi.mocked(discord.validateDiscordCode).mockResolvedValue(ok({ discordId: 'd1', discordName: 'alice' }) as any)
	})
	afterEach(() => {
		env.INTERNAL_API_KEY = original
	})

	it('completes a link started on Nakama', async () => {
		vi.mocked(adminClient.callNakamaRpc).mockResolvedValue(ok({}))
		const state = await linkUrlState()
		const res = await request(app).get('/api/auth/discord/callback').query({ code: 'c', state })
		expect(res.status).toBe(200)
		expect(res.text).toContain('Discord Linked!')
		expect(adminClient.callNakamaRpc).toHaveBeenCalledWith(
			'admin_discord_set',
			expect.objectContaining({ userId: NAKAMA_ID, discordUsername: 'alice' }),
		)
	})

	it('shows the linked-elsewhere page', async () => {
		vi.mocked(adminClient.callNakamaRpc).mockResolvedValue(err('conflict'))
		const res = await request(app).get('/api/auth/discord/callback').query({ code: 'c', state: await linkUrlState() })
		expect(res.status).toBe(409)
		expect(res.text).toContain('Already Linked')
	})

	it('uses a state only once', async () => {
		vi.mocked(adminClient.callNakamaRpc).mockResolvedValue(ok({}))
		const state = await linkUrlState()
		await request(app).get('/api/auth/discord/callback').query({ code: 'c', state })
		const again = await request(app).get('/api/auth/discord/callback').query({ code: 'c', state })
		expect(again.text).not.toContain('Discord Linked!')
		expect(adminClient.callNakamaRpc).toHaveBeenCalledTimes(1)
	})

	it('refuses a bad link-url request', async () => {
		const res = await request(app)
			.post('/internal/nakama/discord/link-url')
			.set('X-BMP-Internal-Key', KEY)
			.send({ nakamaUserId: 'x' })
		expect(res.status).toBe(400)
	})

	it('follows an unlink on the player row', async () => {
		const players = await import('../../infrastructure/gateways/player.gateway.js')
		vi.mocked(players.findPlayerByNakamaUserId).mockResolvedValueOnce({ id: 'p1' } as any)
		const res = await request(app)
			.post('/internal/nakama/discord/unlinked')
			.set('X-BMP-Internal-Key', KEY)
			.send({ nakamaUserId: NAKAMA_ID })
		expect(res.status).toBe(200)
		expect(players.unlinkDiscord).toHaveBeenCalledWith('p1')
	})
})
