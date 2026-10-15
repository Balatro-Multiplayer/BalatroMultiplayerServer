import { describe, expect, it } from 'vitest'
import {
	nakamaModeOf,
	nakamaRatingEntries,
	replayPlacements,
	resolvedInSeason,
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

describe('replayPlacements', () => {
	const a = { playerId: 'a', place: 1 }
	const b = { playerId: 'b', place: 2 }
	it('replays every placement of a game Nakama rated (or an unmarked one)', () => {
		expect(replayPlacements([a, b])).toEqual([a, b])
		expect(
			replayPlacements([
				{ ...a, rated: true },
				{ ...b, rated: true },
			]),
		).toEqual([a, b])
	})
	it('skips a game Nakama did not rate: disputed, or one player flagged', () => {
		expect(
			replayPlacements([
				{ ...a, rated: false },
				{ ...b, rated: false },
			]),
		).toBeNull()
		expect(
			replayPlacements([
				{ ...a, rated: false },
				{ ...b, rated: true },
			]),
		).toBeNull()
	})
	it('drops only the unrated player of a bigger game', () => {
		const c = { playerId: 'c', place: 3 }
		expect(
			replayPlacements([
				{ ...a, rated: false },
				{ ...b, rated: true },
				{ ...c, rated: true },
			]),
		).toEqual([b, c])
	})
	it('treats missing placements as nothing to replay', () => {
		expect(replayPlacements(null)).toBeNull()
	})
})

describe('resolvedInSeason', () => {
	const start = new Date(Date.UTC(2026, 0, 1))
	const end = new Date(Date.UTC(2026, 3, 1))
	it('takes a match resolved within the season', () => {
		expect(
			resolvedInSeason(new Date(Date.UTC(2026, 1, 1)), {
				startedAt: start,
				endedAt: end,
			}),
		).toBe(true)
		expect(
			resolvedInSeason(new Date(Date.UTC(2027, 1, 1)), {
				startedAt: start,
				endedAt: null,
			}),
		).toBe(true)
	})
	it("leaves out a later season's matches when voiding an ended season", () => {
		expect(
			resolvedInSeason(new Date(Date.UTC(2026, 4, 1)), {
				startedAt: start,
				endedAt: end,
			}),
		).toBe(false)
		expect(resolvedInSeason(end, { startedAt: start, endedAt: end })).toBe(
			false,
		)
		expect(resolvedInSeason(null, { startedAt: start, endedAt: end })).toBe(
			false,
		)
	})
})
