import { describe, expect, it } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import {
	afterMatchmakerAdd,
	beforeMatchmakerRemove,
	clearMatched,
	countQueues,
	QUEUE_COLLECTION,
	liveRecords,
	QUEUE_STALE_MS,
	recordOf,
	rpcQueueCounts,
} from './queue'

const ADD = (mode: string, kind: string, modId = 'MultiplayerSPDRN') => ({
	matchmakerAdd: { minCount: 2, maxCount: 2, query: '*', stringProperties: { modId, mode, kind } },
})
const TICKET = (ticket: string) => ({ matchmakerTicket: { ticket } })
const label = (fields: object) => JSON.stringify({ modId: 'MultiplayerSPDRN', type: 'public', size: 2, ...fields })

describe('recordOf', () => {
	it('keys a ranked ticket the way the API keys its queue', () => {
		expect(recordOf(ADD('standard', 'ranked'), TICKET('t1'), 's1', 5)).toEqual({
			modId: 'MultiplayerSPDRN',
			gameMode: 'ranked:standard',
			ticket: 't1',
			sessionId: 's1',
			at: 5,
		})
	})
	it('accepts snake_case envelopes', () => {
		const input = { matchmaker_add: { string_properties: { modId: 'M', mode: 'm', kind: 'casual' } } }
		expect(recordOf(input, { matchmaker_ticket: { ticket: 't' } }, 's', 0)).toMatchObject({ gameMode: 'm' })
	})
	it('ignores tickets that name no queue', () => {
		expect(recordOf({ matchmakerAdd: { stringProperties: {} } }, TICKET('t'), 's', 0)).toBeNull()
		expect(recordOf(ADD('standard', 'casual'), null, 's', 0)).toBeNull()
	})
})

describe('countQueues', () => {
	it('counts fresh records and matchmade lobbies of the mod per queue', () => {
		const now = QUEUE_STALE_MS * 2
		const records = [
			{ modId: 'MultiplayerSPDRN', gameMode: 'standard', sessionId: 's', ticket: 'a', at: now - 1000 },
			{ modId: 'MultiplayerSPDRN', gameMode: 'standard', sessionId: 's', ticket: 'b', at: now },
			{ modId: 'MultiplayerSPDRN', gameMode: 'ranked:standard', sessionId: 's', ticket: 'c', at: 0 }, // stale
			{ modId: 'Other', gameMode: 'standard', sessionId: 's', ticket: 'd', at: now },
		]
		const labels = [
			label({ mode: 'standard' }),
			label({ mode: 'ranked:standard', size: 3 }),
			label({ mode: '', type: 'private' }),
			label({ mode: 'standard', modId: 'Other' }),
			'not json',
		]
		expect(countQueues('MultiplayerSPDRN', records, labels, now)).toEqual({
			modId: 'MultiplayerSPDRN',
			gameModes: {
				standard: { queued: 2, inMatch: 2 },
				'ranked:standard': { queued: 0, inMatch: 3 },
			},
		})
	})
})

describe('queue records', () => {
	it('follow a ticket from add to remove', () => {
		const nk = fakeNk()
		const ctx = playerCtx('u1')
		afterMatchmakerAdd(ctx, fakeLogger, nk as any, TICKET('t1'), ADD('standard', 'casual'))
		afterMatchmakerAdd(ctx, fakeLogger, nk as any, TICKET('t2'), ADD('fast', 'casual'))
		expect(nk.objects.size).toBe(2)
		const envelope = { matchmakerRemove: { ticket: 't1' } }
		expect(beforeMatchmakerRemove(ctx, fakeLogger, nk as any, envelope)).toBe(envelope)
		expect([...nk.objects.keys()]).toEqual([`${QUEUE_COLLECTION}/u1/MultiplayerSPDRN:fast`])
	})
	it('are never written for a ticket removed before its add hook ran', () => {
		const nk = fakeNk()
		const ctx = playerCtx('u1')
		beforeMatchmakerRemove(ctx, fakeLogger, nk as any, { matchmakerRemove: { ticket: 't1' } })
		afterMatchmakerAdd(ctx, fakeLogger, nk as any, TICKET('t1'), ADD('standard', 'casual'))
		expect(nk.objects.size).toBe(0)
	})
	it('leave tombstones that a later count sweeps', () => {
		const nk = fakeNk({ streamUserList: () => [] })
		beforeMatchmakerRemove(playerCtx('u1'), fakeLogger, nk as any, { matchmakerRemove: { ticket: 'gone' } })
		liveRecords(nk as any, 'MultiplayerSPDRN', Date.now())
		expect(nk.objects.size).toBe(1)
		liveRecords(nk as any, 'MultiplayerSPDRN', Date.now() + 61_000)
		expect(nk.objects.size).toBe(0)
	})
	it('are cleared for matched players', () => {
		const nk = fakeNk()
		for (const u of ['u1', 'u2']) {
			afterMatchmakerAdd(playerCtx(u), fakeLogger, nk as any, TICKET('t' + u), ADD('standard', 'casual'))
			afterMatchmakerAdd(playerCtx(u), fakeLogger, nk as any, TICKET('f' + u), ADD('fast', 'casual'))
		}
		clearMatched(nk as any, 'MultiplayerSPDRN', 'standard', ['u1', 'u2'])
		expect([...nk.objects.keys()].sort()).toEqual([
			`${QUEUE_COLLECTION}/u1/MultiplayerSPDRN:fast`,
			`${QUEUE_COLLECTION}/u2/MultiplayerSPDRN:fast`,
		])
	})
	it('of disconnected sessions are not counted, and are deleted', () => {
		const online: { [userId: string]: string[] } = { u1: ['s1'], u2: [] }
		const nk = fakeNk({
			streamUserList: ({ mode, subject }: { mode: number; subject: string }) =>
				mode === 0 ? (online[subject] || []).map((sessionId) => ({ userId: subject, sessionId })) : [],
		})
		const ctx = (u: string, sessionId: string) => ({ ...playerCtx(u), sessionId })
		afterMatchmakerAdd(ctx('u1', 's1'), fakeLogger, nk as any, TICKET('t1'), ADD('standard', 'casual'))
		afterMatchmakerAdd(ctx('u2', 's2'), fakeLogger, nk as any, TICKET('t2'), ADD('standard', 'casual'))
		afterMatchmakerAdd(ctx('u2', 's2'), fakeLogger, nk as any, TICKET('t3'), ADD('x', 'casual', 'Other'))
		expect(liveRecords(nk as any, 'MultiplayerSPDRN', Date.now()).map((r) => r.ticket)).toEqual(['t1'])
		expect([...nk.objects.keys()].sort()).toEqual([
			`${QUEUE_COLLECTION}/u1/MultiplayerSPDRN:standard`,
			`${QUEUE_COLLECTION}/u2/Other:x`,
		])
	})
})

describe('rpcQueueCounts', () => {
	it('answers the API shape, querying the mod\'s matchmade lobbies', () => {
		let query = ''
		const nk = fakeNk({
			streamUserList: ({ subject }: { subject: string }) => [{ userId: subject, sessionId: 's' }],
			matchList: (_l: number, _a: boolean, _label: null, _min: number, _max: null, q: string) => {
				query = q
				return [{ matchId: 'm', authoritative: true, size: 2, label: label({ mode: 'standard' }) }]
			},
		})
		afterMatchmakerAdd({ ...playerCtx('u1'), sessionId: 's' }, fakeLogger, nk as any, TICKET('t'), ADD('standard', 'casual'))
		const out = JSON.parse(rpcQueueCounts(playerCtx('u9'), fakeLogger, nk as any, '{"modId":"MultiplayerSPDRN"}'))
		expect(out).toEqual({ modId: 'MultiplayerSPDRN', gameModes: { standard: { queued: 1, inMatch: 2 } } })
		expect(query).toBe('+label.modId:MultiplayerSPDRN +label.type:public')
	})
	it('refuses a missing modId', () => {
		expect(() => rpcQueueCounts(playerCtx('u'), fakeLogger, fakeNk() as any, '{}')).toThrow()
	})
})
