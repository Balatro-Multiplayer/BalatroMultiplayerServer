import { describe, expect, it } from 'vitest'
import { ratingChangesOf } from '../../features/ratings/season-replay-changes.js'

const record = (rating: number, gamesPlayed = 6) => ({
	rating,
	wins: 3,
	losses: gamesPlayed - 3,
	gamesPlayed,
	seasonBest: 1234 as number | string | null,
	lastMatchAt: 1_700_000_000_000,
})

describe('ratingChangesOf', () => {
	it('lists each player on each board, sorted, with whole ratings and their account', () => {
		const changes = ratingChangesOf(
			{
				'MultiplayerSPDRN:triple': {
					u2: { name: 'Two', before: null, after: record(580.6, 3) },
				},
				'MultiplayerPvP:solo': {
					u2: { name: 'Two', before: record(600.4), after: record(640.5, 7) },
					u1: { name: 'One', before: record(700), after: record(690) },
				},
			},
			new Map([['u2', 'p2']]),
		)
		expect(changes).toEqual([
			{
				userId: 'u1',
				playerId: null,
				name: 'One',
				modId: 'MultiplayerPvP',
				mode: 'solo',
				before: { rating: 700, wins: 3, losses: 3, gamesPlayed: 6 },
				after: { rating: 690, wins: 3, losses: 3, gamesPlayed: 6 },
			},
			{
				userId: 'u2',
				playerId: 'p2',
				name: 'Two',
				modId: 'MultiplayerPvP',
				mode: 'solo',
				before: { rating: 600, wins: 3, losses: 3, gamesPlayed: 6 },
				after: { rating: 641, wins: 3, losses: 4, gamesPlayed: 7 },
			},
			{
				userId: 'u2',
				playerId: 'p2',
				name: 'Two',
				modId: 'MultiplayerSPDRN',
				mode: 'triple',
				before: null,
				after: { rating: 581, wins: 3, losses: 0, gamesPlayed: 3 },
			},
		])
	})
})
