import { describe, expect, it } from 'vitest'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import {
	rpcAdminRatingsBoardExport,
	rpcAdminRatingsSeasonClear,
	rpcAdminRatingsSeasonExport,
} from './season_board'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const record = (rating: number) => ({
	rating,
	wins: 1,
	losses: 0,
	gamesPlayed: 6,
	seasonBest: null,
	lastMatchAt: 1,
})

function nkWithBoards() {
	const board = new Map<string, Map<string, any>>()
	const nk = fakeNk({
		board,
		leaderboardRecordsList: (id: string) => {
			const records = board.get(id)
			if (!records) throw new Error('leaderboard not found')
			return {
				records: [...records.entries()].map(([ownerId, r]) => ({
					ownerId,
					...r,
				})),
				nextCursor: '',
			}
		},
		leaderboardRecordDelete: (id: string, owner: string) => {
			board.get(id)?.delete(owner)
		},
	})
	const put = (key: string, userId: string, rating: number) => {
		nk.objects.set(`${RATINGS_COLLECTION}/${userId}/${key}`, {
			value: record(rating),
			version: 1,
		})
		if (!board.has(key)) board.set(key, new Map())
		board
			.get(key)
			?.set(userId, {
				username: userId,
				score: rating,
				subscore: 1,
				metadata: {},
			})
	}
	put('Mod:solo:2', A, 700)
	put('Mod:solo:2', B, 800)
	put('Mod:solo:1', A, 650)
	put('Mod:ranked:solo:2', A, 900)
	return nk
}

const call = (rpc: any, nk: any, body: unknown, ctx = serverCtx()) =>
	JSON.parse(rpc(ctx, fakeLogger as any, nk as any, JSON.stringify(body)))

describe('season board export', () => {
	it('lists only the named season, whatever the mode looks like', () => {
		const page = call(rpcAdminRatingsSeasonExport, nkWithBoards(), {
			season: 2,
		})
		expect(page.ratings.map((r: any) => [r.key, r.userId]).sort()).toEqual([
			['Mod:ranked:solo:2', A],
			['Mod:solo:2', A],
			['Mod:solo:2', B],
		])
		expect(page.ratings[0].value.gamesPlayed).toBe(6)
		expect(page.cursor).toBe('')
	})

	it('lists a leaderboard and nothing for a board that was never made', () => {
		const nk = nkWithBoards()
		const page = call(rpcAdminRatingsBoardExport, nk, { board: 'Mod:solo:2' })
		expect(page.records.map((r: any) => r.ownerId).sort()).toEqual([A, B])
		expect(
			call(rpcAdminRatingsBoardExport, nk, { board: 'Mod:none:2' }).records,
		).toEqual([])
	})
})

describe('rpcAdminRatingsSeasonClear', () => {
	it('removes every rating and leaderboard record of the season and no other', () => {
		const nk = nkWithBoards()
		const result = call(rpcAdminRatingsSeasonClear, nk, { season: 2 })
		expect(result).toEqual({ cleared: 3, cursor: '' })
		expect([...nk.objects.keys()]).toEqual([
			`${RATINGS_COLLECTION}/${A}/Mod:solo:1`,
		])
		expect([...nk.board.get('Mod:solo:2').keys()]).toEqual([])
		expect([...nk.board.get('Mod:ranked:solo:2').keys()]).toEqual([])
		expect([...nk.board.get('Mod:solo:1').keys()]).toEqual([A])
	})

	it('is server only and needs a season', () => {
		const nk = nkWithBoards()
		expect(() =>
			rpcAdminRatingsSeasonClear(
				playerCtx(A),
				fakeLogger as any,
				nk as any,
				'{"season":2}',
			),
		).toThrow()
		expect(() =>
			rpcAdminRatingsSeasonClear(
				serverCtx(),
				fakeLogger as any,
				nk as any,
				'{}',
			),
		).toThrow()
		expect(nk.objects.size).toBe(4)
	})
})
