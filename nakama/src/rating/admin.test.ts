import { describe, expect, it } from 'vitest'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { parseRatingsSet, rpcAdminRatingsSet } from './admin'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const KEY = 'MultiplayerSPDRN:ranked:3'

const record = (gamesPlayed: number, rating = 1200) => ({
	rating,
	wins: 1,
	losses: gamesPlayed - 1,
	gamesPlayed,
	seasonBest: null,
	lastMatchAt: 1_700_000_000_000,
})

const request = (entries: unknown[]) => ({ modId: 'MultiplayerSPDRN', mode: 'ranked', season: 3, entries })

function nkWithBoard() {
	const board = new Map<string, { score: number; subscore: number; metadata: any }>()
	return fakeNk({
		board,
		leaderboardCreate: () => {},
		leaderboardRecordWrite: (_id: string, owner: string, _name: string, score: number, subscore: number, metadata: any) => {
			board.set(owner, { score, subscore, metadata })
		},
		leaderboardRecordDelete: (_id: string, owner: string) => {
			board.delete(owner)
		},
	})
}

describe('parseRatingsSet', () => {
	it('takes records and clears', () => {
		const parsed = parseRatingsSet(request([{ userId: A, name: 'A', record: record(6) }, { userId: B, record: null }]))
		expect(parsed).toEqual({
			modId: 'MultiplayerSPDRN',
			mode: 'ranked',
			season: 3,
			entries: [
				{ userId: A, name: 'A', record: record(6) },
				{ userId: B, name: '', record: null },
			],
		})
	})

	it('takes a season best as score text and refuses text that is not', () => {
		const withBest = (seasonBest: unknown) => request([{ userId: A, name: 'A', record: { ...record(6), seasonBest } }])
		expect(typeof parseRatingsSet(withBest('20.17609125905568,3'))).toBe('object')
		expect(typeof parseRatingsSet(withBest('nope'))).toBe('string')
		expect(typeof parseRatingsSet(withBest(Array(101).fill('1').join(',')))).toBe('string')
	})

	it('refuses a bad board, user id or record', () => {
		expect(typeof parseRatingsSet({ ...request([]), season: 0 })).toBe('string')
		expect(typeof parseRatingsSet({ ...request([]), mode: 'bad mode' })).toBe('string')
		expect(typeof parseRatingsSet(request([{ userId: 'nope', record: null }]))).toBe('string')
		expect(typeof parseRatingsSet(request([{ userId: A, record: { ...record(6), wins: -1 } }]))).toBe('string')
		expect(typeof parseRatingsSet(request([{ userId: A }]))).toBe('string')
	})
})

describe('admin_ratings_set', () => {
	it('is server only', () => {
		expect(() => rpcAdminRatingsSet(playerCtx(A), fakeLogger, nkWithBoard() as any, JSON.stringify(request([])))).toThrow()
	})

	it('overwrites ratings, clears the rest, and keeps the board in step', () => {
		const nk = nkWithBoard()
		nk.storageWrite([{ collection: RATINGS_COLLECTION, key: KEY, userId: B, value: record(7, 1500) }])
		nk.board.set(B, { score: 1500, subscore: 1, metadata: {} })

		const out = JSON.parse(
			rpcAdminRatingsSet(
				serverCtx(),
				fakeLogger,
				nk as any,
				JSON.stringify(request([{ userId: A, name: 'A', record: record(6, 1234) }, { userId: B, record: null }])),
			),
		)

		expect(out).toEqual({ written: 1, cleared: 1 })
		expect(nk.storageRead([{ collection: RATINGS_COLLECTION, key: KEY, userId: A }])[0].value).toEqual(record(6, 1234))
		expect(nk.storageRead([{ collection: RATINGS_COLLECTION, key: KEY, userId: B }])).toEqual([])
		expect(nk.board.get(A)?.score).toBe(1234)
		expect(nk.board.has(B)).toBe(false)
	})

	it('keeps a still-placing player off the board', () => {
		const nk = nkWithBoard()
		nk.board.set(A, { score: 1300, subscore: 1, metadata: {} })
		rpcAdminRatingsSet(serverCtx(), fakeLogger, nk as any, JSON.stringify(request([{ userId: A, name: 'A', record: record(3) }])))
		expect(nk.board.has(A)).toBe(false)
		expect(nk.storageRead([{ collection: RATINGS_COLLECTION, key: KEY, userId: A }])[0].value.gamesPlayed).toBe(3)
	})
})
