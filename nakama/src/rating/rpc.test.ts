import { describe, expect, it } from 'vitest'
import { boardEntries } from './rpc'

const DAY = 86400000
const NOW = 1_800_000_000_000

const rec = (ownerId: string, score: number, wins: number, rank: number) =>
	({ ownerId, username: ownerId, score, subscore: wins, rank, metadata: { losses: 0, gamesPlayed: 6, seasonBest: null } }) as unknown as nkruntime.LeaderboardRecord

describe('boardEntries', () => {
	it('shows each rating decayed, as rating_get and the website do', () => {
		const entries = boardEntries(
			[rec('c', 845, 6, 1), rec('d', 355, 0, 2)],
			{
				c: { rating: 845, gamesPlayed: 6, lastMatchAt: NOW - 20.5 * DAY },
				d: { rating: 355, gamesPlayed: 6, lastMatchAt: NOW - 200 * DAY },
			},
			NOW,
		)
		expect(entries.map((e) => [e.playerId, e.rating, e.rank])).toEqual([
			['c', 780, 1],
			['d', 100, 2],
		])
	})

	it('re-ranks the page by the decayed rating, then wins', () => {
		const entries = boardEntries(
			[rec('idle', 900, 9, 11), rec('active', 850, 3, 12), rec('tied', 850, 5, 13)],
			{
				idle: { rating: 900, gamesPlayed: 9, lastMatchAt: NOW - 30 * DAY },
				active: { rating: 850, gamesPlayed: 6, lastMatchAt: NOW - DAY },
				tied: { rating: 850, gamesPlayed: 6, lastMatchAt: NOW - DAY },
			},
			NOW,
		)
		expect(entries.map((e) => [e.rank, e.playerId, e.rating])).toEqual([
			[11, 'tied', 850],
			[12, 'active', 850],
			[13, 'idle', 785],
		])
	})

	it('keeps the stored score when the rating object is missing', () => {
		expect(boardEntries([rec('x', 700, 1, 1)], {}, NOW)[0].rating).toBe(700)
		expect(boardEntries([], {}, NOW)).toEqual([])
	})
})
