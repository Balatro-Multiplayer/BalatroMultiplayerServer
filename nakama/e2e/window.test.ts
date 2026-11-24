// The e2e tests' port of the mod's ticket logic, against the values in the
// mod's own tests/instant_queue_test.lua.
import { describe, expect, it } from 'vitest'
import { instantOpenAt, instantSide, rankedSpread, rankedTicket, rankedWindow, secsToSpan } from './window'

const ranges = { floor: 1200, ceiling: 400, floorMultiplier: 1, ceilingMultiplier: 1 }
const window = (rating: number, wait: number, r = ranges) => {
	const { lo, hi } = rankedWindow(rating, wait, r)
	return [lo, hi]
}

describe('the normal window', () => {
	it('starts at 150, grows 50 every 30 seconds and stops at 600', () => {
		expect([rankedSpread(0), rankedSpread(30), rankedSpread(1000)]).toEqual([150, 200, 600])
	})
	it('takes the time to span a gap', () => {
		expect([0, 150, 151, 300, 600, 5000].map(secsToSpan)).toEqual([0, 0, 30, 90, 270, 270])
	})
})

describe('the instant ranges', () => {
	it('say which range a rating is in', () => {
		expect(instantSide(1500, ranges)).toMatchObject({ side: 'upper', edge: 1200, gap: 300 })
		expect(instantSide(1200, ranges)?.side).toBe('upper')
		expect(instantSide(300, ranges)).toMatchObject({ side: 'lower', edge: 400, gap: 100 })
		expect(instantSide(400, ranges)?.side).toBe('lower')
		expect(instantSide(800, ranges)).toBeNull()
		expect(instantSide(1500, null)).toBeNull()
	})
	it('open up after the normal time to the edge, times the multiplier', () => {
		expect(instantOpenAt(1500, ranges)).toBe(90)
		expect(instantOpenAt(1500, { ...ranges, floorMultiplier: 2 })).toBe(180)
		expect(instantOpenAt(1500, { ...ranges, floorMultiplier: 0.5 })).toBe(45)
		expect(instantOpenAt(1250, ranges)).toBe(0)
		expect(instantOpenAt(2000, ranges)).toBe(270)
		expect(instantOpenAt(800, ranges)).toBeNull()
	})
})

describe('the window', () => {
	it('is the normal one between the ranges', () => {
		expect(window(800, 0)).toEqual([650, 950])
		expect(window(800, 60)).toEqual([550, 1050])
	})
	it('is everyone above the floor for the upper range, until it opens up', () => {
		expect(window(1500, 0)).toEqual([1200, null])
		expect(window(1500, 89)).toEqual([1200, null])
		expect(window(1500, 90)).toEqual([1200, null])
		expect(window(1500, 120)).toEqual([1150, null])
		expect(window(1500, 1000)).toEqual([750, null])
		expect(window(2000, 270)).toEqual([1200, null])
		expect(window(2000, 300)).toEqual([1150, null])
		expect(window(1500, 150, { ...ranges, floorMultiplier: 2 })).toEqual([1200, null])
		expect(window(1500, 180, { ...ranges, floorMultiplier: 2 })).toEqual([1050, null])
	})
	it('mirrors it for the lower range', () => {
		expect(window(100, 0)).toEqual([null, 400])
		expect(window(100, 90)).toEqual([null, 400])
		expect(window(100, 120)).toEqual([null, 450])
		expect(window(300, 0)).toEqual([null, 450])
	})
})

describe('the ticket', () => {
	const base = '+properties.modId:MultiplayerPvP +properties.mode:pvp_ranked_expanded +properties.kind:ranked'
	it('leaves off an unbounded side', () => {
		expect(rankedTicket(1500, 0, ranges).query).toBe(`${base} +properties.rating:>=1200`)
		expect(rankedTicket(100, 0, ranges).query).toBe(`${base} +properties.rating:<=400`)
		expect(rankedTicket(800, 0, ranges).query).toBe(`${base} +properties.rating:>=650 +properties.rating:<=950`)
		expect(rankedTicket(1500, 0, null).query).toBe(`${base} +properties.rating:>=1350 +properties.rating:<=1650`)
		expect(rankedTicket(1500, 0, ranges).numericProperties).toEqual({ rating: 1500 })
	})
})
