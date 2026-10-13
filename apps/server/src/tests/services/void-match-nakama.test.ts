import { describe, expect, it } from 'vitest'
import {
	nakamaModeOf,
	nakamaRatingEntries,
} from '../../infrastructure/db/void-match.js'

type Row = Parameters<typeof nakamaRatingEntries>[0][number]

function row(over: Partial<Row>): Row {
	return {
		playerId: 'p1',
		nakamaUserId: 'n1',
		displayName: 'Alice',
		rating: 1000,
		wins: 0,
		losses: 0,
		gamesPlayed: 0,
		seasonBest: 1000,
		lastMatchAt: null,
		...over,
	} as Row
}

describe('nakamaModeOf', () => {
	it("drops the 'ranked:' prefix Postgres keys boards by", () => {
		expect(nakamaModeOf('ranked:duel')).toBe('duel')
		expect(nakamaModeOf('duel')).toBe('duel')
	})
})

describe('nakamaRatingEntries', () => {
	it('sets every rebuilt rating', () => {
		const last = new Date(Date.UTC(2026, 0, 1))
		const entries = nakamaRatingEntries(
			[],
			[
				row({
					rating: 1040,
					wins: 3,
					losses: 1,
					gamesPlayed: 4,
					lastMatchAt: last,
				}),
			],
		)
		expect(entries).toEqual([
			{
				userId: 'n1',
				name: 'Alice',
				record: {
					rating: 1040,
					wins: 3,
					losses: 1,
					gamesPlayed: 4,
					seasonBest: 1000,
					lastMatchAt: last.getTime(),
				},
			},
		])
	})

	it('clears a player the void left unrated', () => {
		const entries = nakamaRatingEntries(
			[row({}), row({ playerId: 'p2', nakamaUserId: 'n2' })],
			[row({})],
		)
		expect(entries).toContainEqual({ userId: 'n2', name: '', record: null })
		expect(entries).toHaveLength(2)
	})

	it('skips players without a Nakama account', () => {
		const entries = nakamaRatingEntries(
			[row({ playerId: 'p2', nakamaUserId: null })],
			[row({ nakamaUserId: null })],
		)
		expect(entries).toEqual([])
	})
})
