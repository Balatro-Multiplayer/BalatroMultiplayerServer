import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { signJwt, signTosPendingToken } from '../../features/auth/jwt.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { setConfig } from '../../state/config.js'
import { createSession, lobbies, sessions } from '../../state/index.js'
import { Lobby } from '../../state/lobby.js'
import { createTestApp } from './app.js'

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

	it('returns full auth payload after accepting ToS', async () => {
		setConfig({ tosVersion: 1, mods: [], chatAllowlist: new Set() })
		createSession('Alice', { id: 'tos-p1', tosAcceptedVersion: 0 })
		const pendingToken = signTosPendingToken('tos-p1')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)

		expect(res.status).toBe(200)
		expect(res.body).toHaveProperty('token')
		expect(res.body.player).toMatchObject({ id: 'tos-p1' })
	})

	it('returns 401 when session does not exist for the pending token player', async () => {
		const pendingToken = signTosPendingToken('nonexistent-player')

		const res = await request(app)
			.post('/api/auth/accept-tos')
			.set('Authorization', `Bearer ${pendingToken}`)

		expect(res.status).toBe(401)
	})

	it('permanently blocks chat for a chat-ineligible (13-15) account', async () => {
		setConfig({ tosVersion: 1, mods: [], chatAllowlist: new Set() })
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
		setConfig({ tosVersion: 1, mods: [], chatAllowlist: new Set() })
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

describe('GET /api/auth/jokers', () => {
	it('returns 401 without auth', async () => {
		const res = await request(app).get('/api/auth/jokers')
		expect(res.status).toBe(401)
	})

	it('returns the standard joker pool for a plain account', async () => {
		createSession('Alice', { id: 'plain-account' })
		const token = signJwt({ playerId: 'plain-account', steamName: 'Alice' })

		const res = await request(app)
			.get('/api/auth/jokers')
			.set('Authorization', `Bearer ${token}`)

		expect(res.status).toBe(200)
		expect(res.body.jokers).toContain('j_joker')
		expect(res.body.jokers).not.toContain('j_perkeo')
	})

	it('includes a privilege joker only for an account holding that privilege', async () => {
		createSession('Bean', { id: 'privileged-account', privileges: ['bean'] })
		const token = signJwt({ playerId: 'privileged-account', steamName: 'Bean' })

		const res = await request(app)
			.get('/api/auth/jokers')
			.set('Authorization', `Bearer ${token}`)

		expect(res.status).toBe(200)
		expect(res.body.jokers).toContain('j_turtle_bean')
		expect(res.body.jokers).not.toContain('j_vagabond')
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
