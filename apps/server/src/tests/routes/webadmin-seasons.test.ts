import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { signJwt } from '../../features/auth/jwt.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { createSession } from '../../state/index.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/gateways/config.gateway.js', () => ({
	loadConfigFromDb: vi.fn(),
}))

const app = createTestApp()

function authAs(privileges: string[], playerId: string) {
	createSession(playerId, { id: playerId })
	vi.mocked(playerGateway.findPlayerById).mockResolvedValue({ privileges } as any)
	return `Bearer ${signJwt({ playerId, steamName: playerId })}`
}

// Starting, activating or ending a season moves every player's ratings to
// another board: admin-only, like the feature flags and the ToS version.
describe('webadmin season changes are admin-only', () => {
	for (const [path, body] of [
		['/api/webadmin/seasons', { name: 'S2' }],
		['/api/webadmin/seasons/1/activate', {}],
		['/api/webadmin/seasons/1/end', {}],
	] as const) {
		it(`POST ${path}: 403 for a moderator`, async () => {
			const res = await request(app).post(path).set('Authorization', authAs(['moderator'], 'mod-season')).send(body)
			expect(res.status).toBe(403)
		})
	}

	it('an admin gets past the gate (to validation)', async () => {
		const token = authAs(['admin'], 'admin-season')
		expect((await request(app).post('/api/webadmin/seasons').set('Authorization', token).send({ name: '' })).status).toBe(400)
		expect((await request(app).post('/api/webadmin/seasons/abc/activate').set('Authorization', token).send({})).status).toBe(400)
		expect((await request(app).post('/api/webadmin/seasons/1.5/end').set('Authorization', token).send({})).status).toBe(400)
	})

	it('a moderator can still list seasons', async () => {
		const res = await request(app).get('/api/webadmin/seasons').set('Authorization', authAs(['moderator'], 'mod-season-list'))
		expect(res.status).not.toBe(403)
	})
})
