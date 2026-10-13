import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('/internal/nakama/player-sync', () => {
	const KEY = 'secret-key'
	const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'
	afterEach(() => {
		env.INTERNAL_API_KEY = original
	})

	it('creates a player row for a new Steam account', async () => {
		env.INTERNAL_API_KEY = KEY
		const players = await import('../../infrastructure/gateways/player.gateway.js')
		const res = await request(app)
			.post('/internal/nakama/player-sync')
			.set('X-BMP-Internal-Key', KEY)
			.send({ steamId: '7656', nakamaUserId: NAKAMA_ID, steamName: 'Alice' })
		expect(res.status).toBe(200)
		expect(vi.mocked(players.createPlayer)).toHaveBeenCalledWith(
			expect.objectContaining({ steamName: 'Alice', nakamaUserId: NAKAMA_ID }),
		)
		expect(res.body).toMatchObject({ mutedUserIds: [], unresolvedMutedPlayerIds: [], bans: [] })
	})

	it('links an existing player and maps mutes and bans', async () => {
		env.INTERNAL_API_KEY = KEY
		const players = await import('../../infrastructure/gateways/player.gateway.js')
		const mutes = await import('../../infrastructure/gateways/mute.gateway.js')
		const bans = await import('../../infrastructure/gateways/ban.gateway.js')
		vi.mocked(players.findPlayerBySteamIdHash).mockResolvedValueOnce({
			id: 'legacy-1',
			steamIdHash: 'h',
			discordIdHash: null,
			discordUsername: null,
			useDiscordName: false,
			preferredJoker: 'j_mime',
			privileges: ['bean'],
			steamName: 'Old',
			chatEnabled: true,
			chatBlocked: false,
			tosAcceptedVersion: 2,
			deletedAt: null,
		})
		vi.mocked(mutes.listMutes).mockResolvedValueOnce(['legacy-2', 'legacy-3'])
		vi.mocked(players.findNakamaUserIds).mockResolvedValueOnce(new Map([['legacy-2', 'n-2']]))
		vi.mocked(bans.getActiveBans).mockResolvedValueOnce([
			{
				id: 'b1',
				playerId: 'legacy-1',
				banType: 'queue',
				expiresAt: new Date(5000),
				issuedBy: 'admin',
				issuedAt: new Date(0),
				reason: 'dodging',
				liftedAt: null,
				liftedBy: null,
			},
		])
		const res = await request(app)
			.post('/internal/nakama/player-sync')
			.set('X-BMP-Internal-Key', KEY)
			.send({ steamId: '7656', nakamaUserId: NAKAMA_ID, steamName: 'Alice' })
		expect(res.status).toBe(200)
		expect(vi.mocked(players.linkNakamaUser)).toHaveBeenCalledWith('legacy-1', NAKAMA_ID)
		expect(res.body).toMatchObject({
			playerId: 'legacy-1',
			steamName: 'Alice',
			preferredJoker: 'j_mime',
			tosAcceptedVersion: 2,
			mutedUserIds: ['n-2'],
			unresolvedMutedPlayerIds: ['legacy-3'],
			bans: [{ banId: 'b1', type: 'queue', expiresAt: 5000, reason: 'dodging' }],
		})
	})

	it('refuses a malformed body', async () => {
		env.INTERNAL_API_KEY = KEY
		const res = await request(app)
			.post('/internal/nakama/player-sync')
			.set('X-BMP-Internal-Key', KEY)
			.send({ steamId: 'abc', nakamaUserId: NAKAMA_ID })
		expect(res.status).toBe(400)
	})
})

describe('/internal/nakama/integrity', () => {
	const KEY = 'secret-key'
	const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'
	afterEach(() => {
		env.INTERNAL_API_KEY = original
	})

	it('accepts session starts, answers and readiness checks for a Nakama user', async () => {
		env.INTERNAL_API_KEY = KEY
		for (const path of ['session-start', 'answer', 'ranked-readiness']) {
			const res = await request(app)
				.post(`/internal/nakama/integrity/${path}`)
				.set('X-BMP-Internal-Key', KEY)
				.send({ nakamaUserId: NAKAMA_ID, challengeId: 'c-1', refused: true })
			expect(res.status).toBe(202)
			const bad = await request(app)
				.post(`/internal/nakama/integrity/${path}`)
				.set('X-BMP-Internal-Key', KEY)
				.send({ nakamaUserId: 'nope' })
			expect(bad.status).toBe(400)
		}
	})
})
