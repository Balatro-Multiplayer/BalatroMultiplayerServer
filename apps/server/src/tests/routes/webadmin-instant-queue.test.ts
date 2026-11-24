import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signJwt } from '../../features/auth/jwt.js'
import { db } from '../../infrastructure/db/index.js'
import * as configGateway from '../../infrastructure/gateways/config.gateway.js'
import * as queues from '../../infrastructure/gateways/instant-queue.gateway.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import * as staffLog from '../../infrastructure/gateways/staff-log.gateway.js'
import { createSession } from '../../state/index.js'
import { createTestApp } from './app.js'

vi.mock('../../infrastructure/gateways/config.gateway.js', () => ({
	loadConfigFromDb: vi.fn(),
}))
vi.mock('../../infrastructure/gateways/instant-queue.gateway.js', () => ({
	countInRange: vi.fn(),
	getInstantRange: vi.fn(),
	listInstantQueues: vi.fn(),
	setInstantRange: vi.fn(),
}))
vi.mock('../../infrastructure/gateways/staff-log.gateway.js', () => ({
	recordStaffAction: vi.fn(),
}))

const app = createTestApp()
const EMPTY = {
	enabled: false,
	floor: null,
	ceiling: null,
	floorMultiplier: 1,
	ceilingMultiplier: 1,
}

function authAs(privileges: string[], playerId = 'iq-player') {
	createSession('IQ', { id: playerId })
	vi.mocked(playerGateway.findPlayerById).mockResolvedValue({
		privileges,
	} as any)
	return `Bearer ${signJwt({ playerId, steamName: 'IQ' })}`
}

beforeEach(() => {
	// The shared db mock has no transaction; run the callback on a stand-in.
	;(db as any).transaction = vi.fn(async (fn: any) => fn({}))
	vi.mocked(queues.countInRange).mockResolvedValue({
		floor: 100,
		ceiling: null,
	})
	vi.mocked(queues.getInstantRange).mockResolvedValue(EMPTY)
	vi.mocked(queues.listInstantQueues).mockResolvedValue([
		{
			modId: 'M',
			gameMode: 'standard',
			label: 'M standard',
			range: EMPTY,
			rated: 250,
		},
	])
	vi.mocked(configGateway.loadConfigFromDb).mockResolvedValue({} as any)
	vi.mocked(staffLog.recordStaffAction).mockClear()
	vi.mocked(queues.setInstantRange).mockClear()
})

describe('instant queue access', () => {
	it('opens to an admin and to the instaqueue privilege, not to a moderator or a player', async () => {
		for (const [privileges, status] of [
			[['admin'], 200],
			[['instaqueue'], 200],
			[['moderator'], 403],
			[['tester'], 403],
			[[], 403],
		] as const) {
			const res = await request(app)
				.get('/api/webadmin/instant-queue')
				.set('Authorization', authAs([...privileges]))
			expect(res.status).toBe(status)
		}
	})

	it('needs a login', async () => {
		expect((await request(app).get('/api/webadmin/instant-queue')).status).toBe(
			401,
		)
	})

	it('lists the queues with their player counts', async () => {
		const res = await request(app)
			.get('/api/webadmin/instant-queue')
			.set('Authorization', authAs(['instaqueue']))
		expect(res.body.queues).toEqual([
			{
				modId: 'M',
				gameMode: 'standard',
				label: 'M standard',
				range: EMPTY,
				rated: 250,
				counts: { floor: 100, ceiling: null },
			},
		])
	})

	it('counts the edges being typed', async () => {
		const res = await request(app)
			.get(
				'/api/webadmin/instant-queue/count?modId=M&gameMode=standard&floor=1200',
			)
			.set('Authorization', authAs(['instaqueue']))
		expect(res.status).toBe(200)
		expect(queues.countInRange).toHaveBeenCalledWith(
			'M',
			'standard',
			1200,
			null,
		)
		const bad = await request(app)
			.get(
				'/api/webadmin/instant-queue/count?modId=M&gameMode=standard&floor=12.5',
			)
			.set('Authorization', authAs(['instaqueue']))
		expect(bad.status).toBe(400)
	})
})

describe('PUT /api/webadmin/instant-queue/:modId/:gameMode', () => {
	const put = (privileges: string[], body: object) =>
		request(app)
			.put('/api/webadmin/instant-queue/M/standard')
			.set('Authorization', authAs(privileges))
			.send(body)

	it('saves the range, logs it as the instaqueue holder and reloads the config', async () => {
		const res = await put(['instaqueue'], {
			enabled: true,
			floor: 1200,
			ceiling: 400,
			floorMultiplier: 1.5,
			reason: 'Long waits',
		})
		expect(res.status).toBe(200)
		const range = {
			enabled: true,
			floor: 1200,
			ceiling: 400,
			floorMultiplier: 1.5,
			ceilingMultiplier: 1,
		}
		expect(queues.setInstantRange).toHaveBeenCalledWith(
			expect.anything(),
			'M',
			'standard',
			range,
		)
		expect(staffLog.recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: { playerId: 'iq-player', role: 'instaqueue' },
				action: 'instant_queue_edit',
				reason: 'Long waits',
				detail: {
					modId: 'M',
					gameMode: 'standard',
					before: EMPTY,
					after: range,
				},
			}),
		)
		expect(configGateway.loadConfigFromDb).toHaveBeenCalled()
		expect(res.body.range).toEqual(range)
	})

	it('logs an admin as an admin', async () => {
		await put(['admin'], { floor: 1000, reason: 'x' })
		expect(staffLog.recordStaffAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				staff: { playerId: 'iq-player', role: 'admin' },
			}),
		)
	})

	it('refuses a moderator, a missing reason and an invalid range', async () => {
		expect(
			(await put(['moderator'], { floor: 1000, reason: 'x' })).status,
		).toBe(403)
		expect((await put(['instaqueue'], { floor: 1000 })).status).toBe(400)
		expect(
			(await put(['instaqueue'], { floor: 500, ceiling: 600, reason: 'x' }))
				.status,
		).toBe(400)
		expect(
			(await put(['instaqueue'], { floorMultiplier: 0, reason: 'x' })).status,
		).toBe(400)
		expect(queues.setInstantRange).not.toHaveBeenCalled()
	})
})
