import { describe, expect, it } from 'vitest'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { boardId } from './apply'
import { PLACEMENT_GAMES } from './elo'
import { boardEntries, rpcRatingGet } from './rpc'
import { currentSeason } from './season'

const DAY = 86400000
const NOW = 1_800_000_000_000

const rec = (ownerId: string, score: number, wins: number, rank: number) =>
	({ ownerId, username: ownerId, score, subscore: wins, rank, metadata: { losses: 0, gamesPlayed: 6, seasonBest: null } }) as unknown as nkruntime.LeaderboardRecord

describe('boardEntries', () => {
	it('shows each rating decayed, as rating_get and the website do', () => {
		const entries = boardEntries(
			[rec('c', 1645, 6, 1), rec('d', 1300, 0, 2), rec('e', 900, 0, 3)],
			{
				c: { rating: 1645, gamesPlayed: 6, lastMatchAt: NOW - 20.5 * DAY },
				d: { rating: 1300, gamesPlayed: 6, lastMatchAt: NOW - 200 * DAY },
				e: { rating: 900, gamesPlayed: 6, lastMatchAt: NOW - 200 * DAY },
			},
			NOW,
			'MultiplayerPvP',
		)
		expect(entries.map((e) => [e.playerId, e.rating, e.rank])).toEqual([
			['c', 1580, 1],
			['d', 1200, 2],
			['e', 900, 3],
		])
	})

	it('re-ranks the page by the decayed rating, then wins', () => {
		const entries = boardEntries(
			[rec('idle', 1700, 9, 11), rec('active', 1650, 3, 12), rec('tied', 1650, 5, 13)],
			{
				idle: { rating: 1700, gamesPlayed: 9, lastMatchAt: NOW - 30 * DAY },
				active: { rating: 1650, gamesPlayed: 6, lastMatchAt: NOW - DAY },
				tied: { rating: 1650, gamesPlayed: 6, lastMatchAt: NOW - DAY },
			},
			NOW,
			'MultiplayerPvP',
		)
		expect(entries.map((e) => [e.rank, e.playerId, e.rating])).toEqual([
			[11, 'tied', 1650],
			[12, 'active', 1650],
			[13, 'idle', 1585],
		])
	})

	it('carries a score season best as score text, also one stored as an old number', () => {
		const withBest = (seasonBest: unknown) =>
			({ ownerId: 'x', username: 'x', score: 700, subscore: 1, rank: 1, metadata: { losses: 0, gamesPlayed: 6, seasonBest } }) as unknown as nkruntime.LeaderboardRecord
		const best = (seasonBest: unknown, modId: string) => boardEntries([withBest(seasonBest)], {}, NOW, modId)[0].seasonBest
		expect(best('20.17609125905568,3', 'MultiplayerPvP')).toBe('20.17609125905568,3')
		expect(best(1e15, 'MultiplayerPvP')).toBe('1000000000000000')
		expect(best(null, 'MultiplayerPvP')).toBeNull()
		expect(best(95_000, 'MultiplayerSPDRN')).toBe(95_000)
	})

	it('keeps the stored score when the rating object is missing', () => {
		expect(boardEntries([rec('x', 700, 1, 1)], {}, NOW, 'MultiplayerPvP')[0].rating).toBe(700)
		expect(boardEntries([], {}, NOW, 'MultiplayerPvP')).toEqual([])
	})
})

describe('rpcRatingGet rank', () => {
	const ME = '11111111-1111-1111-1111-111111111111'
	const MOD = 'MultiplayerPvP'
	const stored = (gamesPlayed: number) => ({
		rating: 1500,
		wins: 4,
		losses: 2,
		gamesPlayed,
		seasonBest: null,
		lastMatchAt: Date.now(),
	})

	// A fake whose boards hold ranked records per owner; an unknown board throws like Nakama's.
	function setup(boards: { [id: string]: { [ownerId: string]: number } }, ratings: { [key: string]: number } = {}) {
		const asked: string[] = []
		const nk = fakeNk({
			leaderboardRecordsList: (id: string, ownerIds: string[] | null) => {
				asked.push(id)
				const board = boards[id]
				if (!board) throw new Error('leaderboard not found')
				return {
					records: [],
					ownerRecords: (ownerIds || [])
						.filter((o) => o in board)
						.map((o) => ({ ownerId: o, username: o, score: 1500, subscore: 4, metadata: {}, rank: board[o] })),
					nextCursor: null,
				}
			},
		})
		for (const [key, gamesPlayed] of Object.entries(ratings))
			nk.objects.set(`${RATINGS_COLLECTION}/${ME}/${key}`, { value: stored(gamesPlayed), version: 1 })
		const get = (mode: string) =>
			JSON.parse(rpcRatingGet(playerCtx(ME), fakeLogger, nk as unknown as nkruntime.Nakama, JSON.stringify({ modId: MOD, mode })))
		return { nk, asked, get }
	}

	const season = () => currentSeason(fakeNk() as unknown as nkruntime.Nakama)
	const key = (mode: string) => boardId(MOD, mode, season())

	it.each([
		['the top', 1],
		['below the first page', 137],
	])('returns the board rank of a placed player (%s)', (_name, rank) => {
		const { get } = setup({ [key('ranked')]: { [ME]: rank } }, { [key('ranked')]: PLACEMENT_GAMES })
		const out = get('ranked')
		expect(out.rank).toBe(rank)
		expect(out.isPlacement).toBe(false)
	})

	it('gives rank null to a placement player with no board record', () => {
		const { get } = setup({ [key('ranked')]: { other: 3 } }, { [key('ranked')]: PLACEMENT_GAMES - 1 })
		const out = get('ranked')
		expect(out.rank).toBeNull()
		expect(out.isPlacement).toBe(true)
	})

	it('gives rank null, never 0, when the board record carries no rank', () => {
		const { get } = setup({ [key('ranked')]: { [ME]: 0 } }, { [key('ranked')]: PLACEMENT_GAMES })
		expect(get('ranked').rank).toBeNull()
	})

	it('gives rank null, without an error, when the mode has no board yet', () => {
		const { get } = setup({}, {})
		const out = get('ranked')
		expect(out.rank).toBeNull()
		expect(out.gamesPlayed).toBe(0)
	})

	it('reads the rank from the same season board as the rating', () => {
		const { asked, get } = setup({ [key('ranked')]: { [ME]: 9 } }, { [key('ranked')]: PLACEMENT_GAMES })
		get('ranked')
		expect(asked).toEqual([key('ranked')])
	})
})
