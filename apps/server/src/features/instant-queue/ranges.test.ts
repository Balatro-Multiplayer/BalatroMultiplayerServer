import { describe, expect, it } from 'vitest'
import { parseRange, rangeKey } from './ranges.js'

describe('parseRange', () => {
	it('takes empty edges and a default multiplier of 1', () => {
		expect(parseRange({})).toEqual({
			ok: true,
			range: {
				enabled: false,
				floor: null,
				ceiling: null,
				floorMultiplier: 1,
				ceilingMultiplier: 1,
			},
		})
	})

	it('takes a floor, a ceiling and multipliers', () => {
		expect(
			parseRange({
				enabled: true,
				floor: 1200,
				ceiling: 400,
				floorMultiplier: 1.5,
				ceilingMultiplier: 0.5,
			}),
		).toEqual({
			ok: true,
			range: {
				enabled: true,
				floor: 1200,
				ceiling: 400,
				floorMultiplier: 1.5,
				ceilingMultiplier: 0.5,
			},
		})
	})

	it('refuses an edge that is not a whole rating in range', () => {
		for (const floor of [1200.5, -1, 10001, '1200', Number.NaN])
			expect(parseRange({ floor }).ok).toBe(false)
		expect(parseRange({ ceiling: 'x' }).ok).toBe(false)
	})

	it('refuses a ceiling at or above the floor', () => {
		expect(parseRange({ floor: 800, ceiling: 800 }).ok).toBe(false)
		expect(parseRange({ floor: 800, ceiling: 900 }).ok).toBe(false)
		expect(parseRange({ floor: 801, ceiling: 800 }).ok).toBe(true)
	})

	it('refuses a multiplier out of range', () => {
		expect(parseRange({ floorMultiplier: 0 }).ok).toBe(false)
		expect(parseRange({ ceilingMultiplier: 11 }).ok).toBe(false)
		expect(parseRange({ floorMultiplier: '2' }).ok).toBe(false)
	})

	it('refuses an enabled that is not true or false', () => {
		expect(parseRange({ enabled: 'yes' }).ok).toBe(false)
	})

	it('refuses a body that is not an object', () => {
		expect(parseRange(null).ok).toBe(false)
		expect(parseRange([]).ok).toBe(false)
	})
})

describe('rangeKey', () => {
	it('joins mod and mode', () => {
		expect(rangeKey('MultiplayerPvP', 'standard')).toBe(
			'MultiplayerPvP:standard',
		)
	})
})
