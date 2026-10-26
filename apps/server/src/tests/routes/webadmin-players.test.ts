import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { signJwt } from '../../features/auth/jwt.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { insertBan, liftBan, listBans } from '../../infrastructure/gateways/ban.gateway.js'
import { db } from '../../infrastructure/db/index.js'
import {
	banInNakama,
	liftNetworkBanInNakama,
	networkBansInNakama,
} from '../../infrastructure/nakama/moderation-sync.js'
import { createSession } from '../../state/index.js'
import { createTestApp } from './app.js'

vi.mock(
	'../../infrastructure/nakama/moderation-sync.js',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		banInNakama: vi.fn().mockResolvedValue(true),
		networkBansInNakama: vi.fn().mockResolvedValue({ ok: true, value: [] }),
		liftNetworkBanInNakama: vi.fn().mockResolvedValue({ ok: true, value: null }),
		nakamaUserIdOf: vi.fn().mockResolvedValue(null),
	}),
)

const app = createTestApp()

function authAsModerator(playerId: string, steamName: string) {
	createSession(steamName, { id: playerId })
	vi.mocked(playerGateway.findPlayerById).mockResolvedValue({
		privileges: ['moderator'],
	} as any)
	return `Bearer ${signJwt({ playerId, steamName })}`
}

function authAsAdmin(playerId: string, steamName: string) {
	createSession(steamName, { id: playerId })
	vi.mocked(playerGateway.findPlayerById).mockResolvedValue({
		privileges: ['admin'],
	} as any)
	return `Bearer ${signJwt({ playerId, steamName })}`
}

describe('PATCH /api/webadmin/players/:id/privileges', () => {
	it('returns 403 when the requester holds only moderator (cannot grant privileges, including to itself)', async () => {
		const token = authAsModerator('mod-1', 'Mod')
		const res = await request(app)
			.patch('/api/webadmin/players/mod-1/privileges')
			.set('Authorization', token)
			.send({ privileges: ['moderator', 'admin'] })

		expect(res.status).toBe(403)
	})

	it('returns 200 and applies the update when the requester is an admin', async () => {
		const token = authAsAdmin('admin-1', 'Admin')
		;(db as any).update = vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					returning: vi
						.fn()
						.mockResolvedValue([{ id: 'target-1', privileges: ['moderator'] }]),
				}),
			}),
		})

		const res = await request(app)
			.patch('/api/webadmin/players/target-1/privileges')
			.set('Authorization', token)
			.send({ privileges: ['moderator'] })

		expect(res.status).toBe(200)
		expect(res.body.privileges).toEqual(['moderator'])
	})
})

describe('POST /api/webadmin/players/:id/bans (§21.3)', () => {
	it('records the ban and has Nakama enforce it at once', async () => {
		const modToken = authAsAdmin('admin-4', 'Admin4')
		const ban = {
			id: 'ban-2',
			playerId: 'target-2',
			banType: 'account' as const,
			expiresAt: null,
			issuedBy: 'admin:admin-4',
			issuedAt: new Date(),
			reason: 'test',
			liftedAt: null,
			liftedBy: null,
		}
		vi.mocked(insertBan).mockResolvedValue(ban)

		const res = await request(app)
			.post('/api/webadmin/players/target-2/bans')
			.set('Authorization', modToken)
			.send({ type: 'account', reason: 'test' })

		expect(res.status).toBe(201)
		expect(vi.mocked(banInNakama)).toHaveBeenCalledWith(ban)
	})
})

describe('POST /api/webadmin/players/:id/bans: the queue role table', () => {
	const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
	const issue = (token: string, body: Record<string, unknown>) =>
		request(app).post('/api/webadmin/players/target-3/bans').set('Authorization', token).send(body)

	it('lets a moderator issue a 7-day queue ban and a 24-hour chat ban', async () => {
		const token = authAsModerator('mod-2', 'Mod2')
		vi.mocked(insertBan).mockResolvedValue({ id: 'ban-3' } as any)
		expect((await issue(token, { type: 'queue', expiresAt: inDays(7) })).status).toBe(201)
		expect((await issue(token, { type: 'chat', expiresAt: inDays(1) })).status).toBe(201)
		expect(vi.mocked(insertBan)).toHaveBeenCalledWith(expect.objectContaining({ issuedBy: 'moderator:mod-2' }))
	})

	it('refuses a moderator an account ban, a permanent ban and a queue ban past 7 days', async () => {
		const token = authAsModerator('mod-3', 'Mod3')
		for (const body of [
			{ type: 'account', expiresAt: inDays(1) },
			{ type: 'account' },
			{ type: 'queue' },
			{ type: 'queue', expiresAt: inDays(30) },
			{ type: 'chat' },
		]) {
			const res = await issue(token, body)
			expect(res.status, JSON.stringify(body)).toBe(403)
		}
		expect(vi.mocked(insertBan)).not.toHaveBeenCalled()
		expect(vi.mocked(banInNakama)).not.toHaveBeenCalled()
	})

	it('lets an admin issue a permanent account ban', async () => {
		const token = authAsAdmin('admin-5', 'Admin5')
		vi.mocked(insertBan).mockResolvedValue({ id: 'ban-4' } as any)
		expect((await issue(token, { type: 'account' })).status).toBe(201)
		expect(vi.mocked(insertBan)).toHaveBeenCalledWith(expect.objectContaining({ issuedBy: 'admin:admin-5' }))
	})
})

describe('DELETE /api/webadmin/players/:id/bans/:banId: the queue role table', () => {
	const ban = (banType: 'chat' | 'queue' | 'account') => ({ id: 'ban-9', playerId: 'target-4', banType }) as any

	it('refuses a moderator lifting an account ban', async () => {
		const token = authAsModerator('mod-4', 'Mod4')
		vi.mocked(listBans).mockResolvedValue([ban('account')])
		const res = await request(app).delete('/api/webadmin/players/target-4/bans/ban-9').set('Authorization', token)
		expect(res.status).toBe(403)
		expect(vi.mocked(liftBan)).not.toHaveBeenCalled()
	})

	it('lets a moderator lift a queue ban', async () => {
		const token = authAsModerator('mod-5', 'Mod5')
		vi.mocked(listBans).mockResolvedValue([ban('queue')])
		vi.mocked(liftBan).mockResolvedValue(ban('queue'))
		const res = await request(app).delete('/api/webadmin/players/target-4/bans/ban-9').set('Authorization', token)
		expect(res.status).toBe(200)
		expect(vi.mocked(liftBan)).toHaveBeenCalledWith('target-4', 'ban-9', 'moderator:mod-5')
	})
})

describe('network bans in the admin panel', () => {
	const networkBan = { banId: 'ban-7', own: false, networks: 2, bannedAt: 1, liftedAt: null }

	it('shows staff the network bans that touch a player', async () => {
		const token = authAsModerator('mod-6', 'Mod6')
		vi.mocked(networkBansInNakama).mockResolvedValue({ ok: true, value: [networkBan] })
		const res = await request(app).get('/api/webadmin/players/target-5/network-bans').set('Authorization', token)
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ networkBans: [networkBan] })
		expect(vi.mocked(networkBansInNakama)).toHaveBeenCalledWith('target-5')
	})

	it('says so when Nakama cannot answer', async () => {
		const token = authAsModerator('mod-7', 'Mod7')
		vi.mocked(networkBansInNakama).mockResolvedValue({ ok: false, error: 'unavailable' })
		const res = await request(app).get('/api/webadmin/players/target-5/network-bans').set('Authorization', token)
		expect(res.status).toBe(503)
	})

	it('lets an admin lift a network ban', async () => {
		const token = authAsAdmin('admin-6', 'Admin6')
		const res = await request(app)
			.delete('/api/webadmin/players/target-5/network-bans/ban-7')
			.set('Authorization', token)
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ lifted: true })
		expect(vi.mocked(liftNetworkBanInNakama)).toHaveBeenCalledWith('ban-7')
	})

	it('refuses a moderator lifting a network ban', async () => {
		const token = authAsModerator('mod-8', 'Mod8')
		const res = await request(app)
			.delete('/api/webadmin/players/target-5/network-bans/ban-7')
			.set('Authorization', token)
		expect(res.status).toBe(403)
		expect(vi.mocked(liftNetworkBanInNakama)).not.toHaveBeenCalled()
	})

	it('is 404 for a network ban not in force', async () => {
		const token = authAsAdmin('admin-7', 'Admin7')
		vi.mocked(liftNetworkBanInNakama).mockResolvedValue({ ok: false, error: 'not_found' })
		const res = await request(app)
			.delete('/api/webadmin/players/target-5/network-bans/ban-7')
			.set('Authorization', token)
		expect(res.status).toBe(404)
	})
})

describe('duplicate ban route removal', () => {
	it('the old secret-gated /admin/players/:id/bans route no longer exists', async () => {
		const res = await request(app)
			.get('/admin/players/some-id/bans')
			.set('x-admin-secret', process.env.ADMIN_SECRET ?? '')
		expect(res.status).toBe(404)
	})

	it('the webadmin player detail route (which includes bans) still works for a privileged player', async () => {
		const token = authAsAdmin('admin-2', 'Admin')
		// listBans is mocked to [] by the global ban.gateway.js mock (tests/setup.ts);
		// findPlayerById's persistent mock (set by authAsAdmin) covers both the
		// webAdmin gate's own lookup and this route's target-player lookup.
		const res = await request(app)
			.get('/api/webadmin/players/some-id')
			.set('Authorization', token)
		expect(res.status).not.toBe(404)
	})
})
