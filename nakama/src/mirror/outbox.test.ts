import { describe, expect, it } from 'vitest'
import { rpcAdminMirrorAck, rpcAdminMirrorPull } from '../admin'
import { LOGS_COLLECTION, RATINGS_COLLECTION, RUNS_COLLECTION, SYSTEM_USER_ID } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { MIRROR_COLLECTION, enqueue, entryKey } from './outbox'

function nakama(): any {
	let next = 0
	return fakeNk({
		uuidv4: () => `u${++next}`,
		accountGetId: (id: string) => ({ customId: id === 'a' ? 'steam:76561198000000001' : '' }),
	})
}

function storeRun(nk: any, runId: string) {
	nk.storageWrite([
		{
			collection: RUNS_COLLECTION,
			key: runId,
			userId: SYSTEM_USER_ID,
			value: { runId, modId: 'M', players: [{ id: 'a' }, { id: 'b' }], logChecks: { a: 'match', b: 'mismatch' } },
		},
		{ collection: LOGS_COLLECTION, key: `${runId}:a`, userId: SYSTEM_USER_ID, value: { events: [[1, 'x', null]] } },
		{ collection: RATINGS_COLLECTION, key: 'M:duel:2', userId: 'a', value: { rating: 640 } },
		{ collection: 'player', key: 'profile', userId: 'b', value: { steamName: 'Bee', legacyPlayerId: 'pg-b' } },
	])
}

const pull = (nk: any, body = {}) => JSON.parse(rpcAdminMirrorPull(serverCtx(), fakeLogger, nk, JSON.stringify(body)))

describe('the mirror outbox', () => {
	it('keys entries in time order', () => {
		expect(entryKey(5, 'z') < entryKey(40, 'a')).toBe(true)
		expect(entryKey(1_700_000_000_000, 'u')).toBe('001700000000000-u')
	})

	it('hands the API a run with its logs, ratings and players, oldest first', () => {
		const nk = nakama()
		storeRun(nk, 'r1')
		enqueue(nk, { kind: 'chat', at: 20, line: { lobbyCode: 'ABC', lobbyId: 'l1', lobbyKind: 'private', userId: 'a', message: 'hi', flagged: false, verdict: null } })
		enqueue(nk, { kind: 'run', at: 10, runId: 'r1', rating: { modId: 'M', mode: 'duel', season: 2 } })

		const { entries, players } = pull(nk)
		expect(entries.map((e: any) => e.kind)).toEqual(['run', 'chat'])
		expect(entries[0].run.logChecks).toEqual({ a: 'match', b: 'mismatch' })
		expect(entries[0].logs).toEqual({ a: { events: [[1, 'x', null]] } })
		expect(entries[0].ratings).toEqual({ a: { rating: 640 } })
		expect(players).toEqual({
			a: { steamId: '76561198000000001', legacyPlayerId: null, displayName: '' },
			b: { steamId: null, legacyPlayerId: 'pg-b', displayName: 'Bee' },
		})
		expect(pull(nk, { limit: 1 }).entries).toHaveLength(1)
	})

	it('keeps an entry until it is acked', () => {
		const nk = nakama()
		storeRun(nk, 'r1')
		enqueue(nk, { kind: 'run', at: 10, runId: 'r1', rating: null })
		const [entry] = pull(nk).entries
		expect(pull(nk).entries).toHaveLength(1)
		rpcAdminMirrorAck(serverCtx(), fakeLogger, nk, JSON.stringify({ keys: [entry.key] }))
		expect(pull(nk).entries).toHaveLength(0)
	})

	it('drops an entry whose run is gone', () => {
		const nk = nakama()
		enqueue(nk, { kind: 'run', at: 10, runId: 'gone', rating: null })
		expect(pull(nk).entries).toEqual([])
		expect([...nk.objects.keys()].some((k) => k.startsWith(MIRROR_COLLECTION))).toBe(false)
	})

	it('is server only', () => {
		const nk = nakama()
		expect(() => rpcAdminMirrorPull(playerCtx('a'), fakeLogger, nk, '{}')).toThrow()
		expect(() => rpcAdminMirrorAck(playerCtx('a'), fakeLogger, nk, '{"keys":[]}')).toThrow()
		expect(() => rpcAdminMirrorAck(serverCtx(), fakeLogger, nk, '{"keys":"x"}')).toThrow()
	})
})
