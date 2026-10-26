import { NOTICE_VERSION } from '@bmp/types'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { signJwt, signTosPendingToken } from '../../features/auth/jwt.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import * as adminClient from '../../infrastructure/nakama/admin-client.js'
import { err, ok } from '../../shared/utils/result.js'
import { setConfig } from '../../state/config.js'
import { createSession, lobbies, sessions } from '../../state/index.js'
import { Lobby } from '../../state/lobby.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/nakama/admin-client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../infrastructure/nakama/admin-client.js')>()),
	callNakamaRpc: vi.fn(),
	isNakamaAdminEnabled: vi.fn(() => true),
}))

const app = createTestApp()
const originalNodeEnv = env.NODE_ENV

describe('POST /api/auth/accept-tos', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const res = await request(app).post('/api/auth/accept-tos')
		expect(res.status).toBe(401)
	})

	it('returns 401 for an invalid pending token', async () => {
		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', 'Bearer not.a.valid.token')
		expect(res.status).toBe(401)
	})

	it('returns 401 for a regular JWT (wrong purpose)', async () => {
		const { signJwt } = await import('../../features/auth/jwt.js')
		createSession('Alice', { id: 'tos-wrong-jwt' })
		const regularToken = signJwt({
			playerId: 'tos-wrong-jwt',
			steamName: 'Alice',
		})

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${regularToken}`)
		expect(res.status).toBe(401)
	})

	it('returns full auth payload after accepting the Notice, and records version and time', async () => {
		createSession('Alice', { id: 'tos-p1', tosAcceptedVersion: 0 })
		const pendingToken = signTosPendingToken('tos-p1')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)

		expect(res.status).toBe(200)
		expect(res.body).toHaveProperty('token')
		expect(res.body.player).toMatchObject({ id: 'tos-p1' })
		expect(vi.mocked(playerGateway.recordNoticeAcceptance)).toHaveBeenCalledWith(
			'tos-p1',
			NOTICE_VERSION,
			expect.any(Date),
		)
	})

	it('returns 401 when session does not exist for the pending token player', async () => {
		const pendingToken = signTosPendingToken('nonexistent-player')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)

		expect(res.status).toBe(401)
	})

	it('permanently blocks chat for a chat-ineligible (13-15) account', async () => {
		createSession('Alice', { id: 'tos-underage', tosAcceptedVersion: 0 })
		const pendingToken = signTosPendingToken('tos-underage')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)
			.send({ chatEligible: false })

		expect(res.status).toBe(200)
		expect(res.body.player).toMatchObject({
			chatEnabled: false,
			chatBlocked: true,
		})
		expect(vi.mocked(playerGateway.updateChatStatus)).toHaveBeenCalledWith(
			'tos-underage',
			false,
			true,
		)
	})

	it('enables chat for a chat-eligible (16+) account', async () => {
		createSession('Alice', { id: 'tos-eligible', tosAcceptedVersion: 0 })
		const pendingToken = signTosPendingToken('tos-eligible')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)
			.send({ chatEligible: true })

		expect(res.status).toBe(200)
		expect(res.body.player).toMatchObject({
			chatEnabled: true,
			chatBlocked: false,
		})
	})
})

describe('POST /api/auth/chat/enable', () => {
	it('returns 403 for a permanently chat-blocked account', async () => {
		createSession('Alice', { id: 'chat-blocked', chatBlocked: true })
		const token = signJwt({ playerId: 'chat-blocked', steamName: 'Alice' })

		const res = await request(app)
			.post('/api/auth/chat/enable')
			.set('Authorization', `Bearer ${token}`)

		expect(res.status).toBe(403)
	})

	it('enables chat for a legacy account that predates the age-gate rollout', async () => {
		createSession('Alice', {
			id: 'legacy-account',
			chatEnabled: false,
			chatBlocked: false,
		})
		const token = signJwt({ playerId: 'legacy-account', steamName: 'Alice' })

		const res = await request(app)
			.post('/api/auth/chat/enable')
			.set('Authorization', `Bearer ${token}`)

		expect(res.status).toBe(200)
		expect(res.body.player).toMatchObject({
			chatEnabled: true,
			chatBlocked: false,
		})
	})
})

describe('avatars (Nakama)', () => {
	const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'
	const CATALOG = {
		avatars: [
			{ id: 'j_joker', unlocked: true, goal: null },
			{ id: 'j_baron', unlocked: false, goal: { kind: 'counter', key: 'wins', threshold: 1, progress: 0 } },
		],
		selected: 'j_joker',
		enabled: true,
		jokers: ['j_joker'],
	}
	const rpc = () => vi.mocked(adminClient.callNakamaRpc)

	function signedIn(id: string, nakamaUserId: string | null, privileges: string[] = []) {
		createSession('Alice', { id, privileges })
		vi.mocked(playerGateway.findPlayerById).mockResolvedValue({ id, nakamaUserId, privileges } as any)
		return signJwt({ playerId: id, steamName: 'Alice' })
	}

	afterEach(() => {
		rpc().mockReset()
	})

	describe('GET /api/auth/jokers', () => {
		it('returns 401 without auth', async () => {
			const res = await request(app).get('/api/auth/jokers')
			expect(res.status).toBe(401)
		})

		it("returns Nakama's view of the player's avatars", async () => {
			const token = signedIn('avatar-p1', NAKAMA_ID)
			rpc().mockResolvedValue(ok(CATALOG))
			const res = await request(app).get('/api/auth/jokers').set('Authorization', `Bearer ${token}`)
			expect(res.status).toBe(200)
			expect(res.body).toEqual(CATALOG)
			expect(rpc()).toHaveBeenCalledWith('admin_avatars_for', { userId: NAKAMA_ID })
		})

		it('asks by privileges for a player with no Nakama account', async () => {
			const token = signedIn('avatar-p2', null, ['bean'])
			rpc().mockResolvedValue(ok(CATALOG))
			await request(app).get('/api/auth/jokers').set('Authorization', `Bearer ${token}`)
			expect(rpc()).toHaveBeenCalledWith('admin_avatars_for', { privileges: ['bean'] })
		})

		it('is unavailable while Nakama is', async () => {
			const token = signedIn('avatar-p3', NAKAMA_ID)
			rpc().mockResolvedValue(err('unreachable'))
			const res = await request(app).get('/api/auth/jokers').set('Authorization', `Bearer ${token}`)
			expect(res.status).toBe(503)
		})
	})

	describe('POST /api/auth/preferences/joker', () => {
		const post = (token: string, preferredJoker: unknown) =>
			request(app).post('/api/auth/preferences/joker').set('Authorization', `Bearer ${token}`).send({ preferredJoker })

		it('sets the joker in Nakama first, then Postgres', async () => {
			const token = signedIn('avatar-p4', NAKAMA_ID)
			const order: string[] = []
			rpc().mockImplementation(async () => {
				order.push('nakama')
				return ok({})
			})
			vi.mocked(playerGateway.updatePreferredJoker).mockImplementation(async () => {
				order.push('postgres')
			})
			const res = await post(token, 'j_baron')
			expect(res.status).toBe(200)
			expect(res.body.player.preferredJoker).toBe('j_baron')
			expect(rpc()).toHaveBeenCalledWith('admin_profile_set', { userId: NAKAMA_ID, preferredJoker: 'j_baron' })
			expect(order).toEqual(['nakama', 'postgres'])
		})

		it("doesn't touch Postgres when Nakama refuses the joker", async () => {
			const token = signedIn('avatar-p5', NAKAMA_ID)
			rpc().mockResolvedValue(err('rejected'))
			vi.mocked(playerGateway.updatePreferredJoker).mockClear()
			const res = await post(token, 'j_mime')
			expect(res.status).toBe(400)
			expect(vi.mocked(playerGateway.updatePreferredJoker)).not.toHaveBeenCalled()
		})

		it('is unavailable while Nakama is', async () => {
			const token = signedIn('avatar-p6', NAKAMA_ID)
			rpc().mockResolvedValue(err('disabled'))
			expect((await post(token, 'j_jolly')).status).toBe(503)
		})

		it('checks the catalog for a player with no Nakama account', async () => {
			const token = signedIn('avatar-p7', null)
			rpc().mockResolvedValue(ok(CATALOG))
			expect((await post(token, 'j_baron')).status).toBe(400)
			expect((await post(token, 'j_joker')).status).toBe(200)
			expect(rpc()).not.toHaveBeenCalledWith('admin_profile_set', expect.anything())
		})

		it('rejects a missing joker', async () => {
			const token = signedIn('avatar-p8', NAKAMA_ID)
			expect((await post(token, 7)).status).toBe(400)
			expect(rpc()).not.toHaveBeenCalled()
		})
	})
})

describe('DELETE /api/auth/account', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const res = await request(app).delete('/api/auth/account')
		expect(res.status).toBe(401)
	})

	it('soft-deletes the player instead of hard-deleting', async () => {
		createSession('Alice', { id: 'del-p1' })
		const token = signJwt({ playerId: 'del-p1', steamName: 'Alice' })

		const res = await request(app)
			.delete('/api/auth/account')
			.set('Authorization', `Bearer ${token}`)

		expect(res.status).toBe(200)
		expect(res.body).toEqual({ ok: true })
		// The fix: deletion goes through softDeletePlayer, never a hard delete of
		// the players row -- this is what keeps playerBans attached/enforceable
		// instead of being cascade-deleted with it.
		expect(vi.mocked(playerGateway.softDeletePlayer)).toHaveBeenCalledWith(
			'del-p1',
		)
	})

	it('clears the session on deletion', async () => {
		createSession('Bob', { id: 'del-p2' })
		const token = signJwt({ playerId: 'del-p2', steamName: 'Bob' })

		await request(app)
			.delete('/api/auth/account')
			.set('Authorization', `Bearer ${token}`)

		expect(sessions.has('del-p2')).toBe(false)
	})
})
