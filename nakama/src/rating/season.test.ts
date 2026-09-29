import { describe, expect, it } from 'vitest'
import { carriedOver, configureSeason, currentSeason, decayedRating } from './season'

const DAY = 24 * 60 * 60 * 1000
const NOW = 500 * DAY
const played = (rating: number, daysAgo: number, gamesPlayed = 10) => ({
	rating,
	gamesPlayed,
	lastMatchAt: NOW - daysAgo * DAY,
})

describe('decayedRating', () => {
	it('leaves a rating alone within the first week', () => {
		expect(decayedRating(played(1000, 7), NOW)).toBe(1000)
	})
	it('takes 5 per whole day past the week', () => {
		expect(decayedRating(played(1000, 10), NOW)).toBe(985)
		expect(decayedRating(played(1000, 10.9), NOW)).toBe(985)
	})
	it('stops at the floor', () => {
		expect(decayedRating(played(150, 100), NOW)).toBe(100)
	})
	it('spares players still placing or who never played', () => {
		expect(decayedRating(played(1000, 30, 3), NOW)).toBe(1000)
		expect(decayedRating({ rating: 600, gamesPlayed: 9, lastMatchAt: 0 }, NOW)).toBe(600)
	})
})

describe('carriedOver', () => {
	it('soft-resets an established rating', () => {
		expect(carriedOver(played(1000, 0), NOW)).toBe(800)
		expect(carriedOver(played(2600, 0), NOW)).toBe(1200)
	})
	it('applies decay before the reset', () => {
		expect(carriedOver(played(1000, 17), NOW)).toBe(775)
	})
	it('carries nothing from a placement-only or missing record', () => {
		expect(carriedOver(played(900, 0, 4), NOW)).toBeUndefined()
		expect(carriedOver(undefined, NOW)).toBeUndefined()
	})
})

describe('configureSeason', () => {
	it('takes positive integers and ignores the rest', () => {
		configureSeason('3')
		expect(currentSeason()).toBe(3)
		configureSeason('nope')
		configureSeason('-1')
		configureSeason(undefined)
		expect(currentSeason()).toBe(3)
		configureSeason('1')
	})
})
