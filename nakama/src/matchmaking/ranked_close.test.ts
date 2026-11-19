import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { afterMatchmakerAdd, QUEUE_COLLECTION } from './queue'
import { rpcAdminRankedLive, rpcAdminRankedQueueCancel } from './ranked_close'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

const queue = (nk: any, userId: string, mode: string, kind: string) =>
	afterMatchmakerAdd(
		playerCtx(userId),
		fakeLogger,
		nk,
		{ matchmakerTicket: { ticket: 't-' + userId } } as any,
		{ matchmakerAdd: { stringProperties: { modId: 'M', mode, kind } } } as any,
	)
const online = { streamUserList: ({ subject }: { subject: string }) => [{ userId: subject, sessionId: '' }] }
const call = (fn: any, nk: any, body: object = {}, ctx = serverCtx()) =>
	JSON.parse(fn(ctx, fakeLogger, nk, JSON.stringify(body)))

describe('admin_ranked_queue_cancel', () => {
	it('tells every ranked ticket holder and keeps casual tickets', () => {
		const nk = fakeNk(online)
		// The record's session id is the ctx one, empty here, as the stream's.
		queue(nk, A, 'standard', 'ranked')
		queue(nk, B, 'standard', 'ranked')
		queue(nk, C, 'standard', 'casual')
		expect(call(rpcAdminRankedQueueCancel, nk, { reason: 'Ranked is closed' })).toEqual({ cancelled: 2 })
		expect(nk.notifications.map((n) => [n.userId, n.code]).sort()).toEqual([
			[A, NotifyCode.QUEUE_CANCELLED],
			[B, NotifyCode.QUEUE_CANCELLED],
		])
		expect(nk.notifications[0].content).toMatchObject({ modId: 'M', mode: 'standard', requeue: false })
		const left = nk.storageList(null, QUEUE_COLLECTION).objects.map((o: any) => o.userId)
		expect(left).toEqual([C])
	})

	it('refuses player sessions', () => {
		expect(() => rpcAdminRankedQueueCancel(playerCtx(A), fakeLogger, fakeNk() as never, '{}')).toThrow()
	})
})

describe('admin_ranked_live', () => {
	const label = (fields: object) => ({ label: JSON.stringify({ modId: 'M', ...fields }) })

	it('counts started ranked matches only', () => {
		const matches = [
			label({ mode: 'ranked:standard', started: true }),
			label({ mode: 'ranked:standard', started: false }),
			label({ mode: 'standard', started: true }),
			{ label: 'not json' },
		]
		const nk = fakeNk({ matchList: () => matches })
		expect(call(rpcAdminRankedLive, nk)).toEqual({ running: 1 })
	})

	it('asks for started matches with a limit above 100 and counts past it', () => {
		const seen: { limit?: number; query?: string | null } = {}
		const many = Array.from({ length: 250 }, () => label({ mode: 'ranked:standard', started: true }))
		const nk = fakeNk({
			matchList: (limit: number, _a: unknown, _l: unknown, _min: unknown, _max: unknown, query: string | null) => {
				Object.assign(seen, { limit, query })
				return many.slice(0, limit)
			},
		})
		expect(call(rpcAdminRankedLive, nk)).toEqual({ running: 250 })
		expect(seen.limit).toBeGreaterThan(250)
		expect(seen.query).toContain('+label.started:T')
	})
})
