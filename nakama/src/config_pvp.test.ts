import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	DEFAULT_CONFIG,
	DEFAULT_PVP_LIMITS,
	PVP_LIMIT_RANGES,
	clientConfig,
	mergeConfig,
	mergePvpLimits,
	parsePvpLimits,
} from './config'
import type { PvpLimits } from './lobby/pvp/core/types'
import { LIMITS } from './lobby/pvp/testing/state'

const names = Object.keys(PVP_LIMIT_RANGES) as (keyof PvpLimits)[]

describe('parsePvpLimits', () => {
	it('is the defaults the PvP tests use', () => {
		expect(DEFAULT_PVP_LIMITS).toEqual(LIMITS)
		expect(DEFAULT_CONFIG.pvpLimits).toEqual(LIMITS)
	})

	it.each([
		['nothing', undefined],
		['null', null],
		['text', 'fast'],
		['a number', 5],
		['a list', [1, 2, 3]],
		['an empty record', {}],
	])('gives the defaults for %s', (_, raw) => {
		expect(parsePvpLimits(raw)).toEqual(DEFAULT_PVP_LIMITS)
	})

	it.each([
		['a text value', { animatingHoldMilliseconds: '60000' }],
		['a fraction', { animatingHoldMilliseconds: 60_000.5 }],
		['NaN', { animatingHoldMilliseconds: Number.NaN }],
		['Infinity', { animatingHoldMilliseconds: Number.POSITIVE_INFINITY }],
		['1e300', { animatingHoldMilliseconds: 1e300 }],
		['below the minimum', { animatingHoldMilliseconds: 999 }],
		['above the maximum', { animatingHoldMilliseconds: 900_001 }],
		['negative', { animatingHoldMilliseconds: -1 }],
		['a boolean', { animatingHoldMilliseconds: true }],
		['null', { animatingHoldMilliseconds: null }],
	])('keeps the default of a limit given %s', (_, raw) => {
		expect(parsePvpLimits(raw)).toEqual(DEFAULT_PVP_LIMITS)
	})

	it('takes each limit on its own, at its edges', () => {
		const lowest = parsePvpLimits(
			Object.fromEntries(
				names.map((name) => [name, PVP_LIMIT_RANGES[name].min]),
			),
		)
		const highest = parsePvpLimits(
			Object.fromEntries(
				names.map((name) => [name, PVP_LIMIT_RANGES[name].max]),
			),
		)
		for (const name of names) {
			expect(lowest[name]).toBe(PVP_LIMIT_RANGES[name].min)
			expect(highest[name]).toBe(PVP_LIMIT_RANGES[name].max)
		}
		expect(
			parsePvpLimits({ awayBudgetMilliseconds: 0, animatingHoldMilliseconds: 0 }),
		).toEqual({
			...DEFAULT_PVP_LIMITS,
			awayBudgetMilliseconds: 0,
		})
	})

	it('keeps every limit inside its range, whatever it is given', () => {
		const anything = fc.oneof(
			fc.integer(),
			fc.double({ noNaN: false }),
			fc.string(),
			fc.constant(null),
			fc.constant(undefined),
			fc.boolean(),
		)
		fc.assert(
			fc.property(
				fc.record({
					animatingHoldMilliseconds: anything,
					animatingBlindMilliseconds: anything,
					awayBudgetMilliseconds: anything,
				}),
				(raw) => {
					const limits = parsePvpLimits(raw)
					for (const name of names) {
						expect(Number.isInteger(limits[name])).toBe(true)
						expect(limits[name]).toBeGreaterThanOrEqual(
							PVP_LIMIT_RANGES[name].min,
						)
						expect(limits[name]).toBeLessThanOrEqual(PVP_LIMIT_RANGES[name].max)
					}
				},
			),
		)
	})
})

describe('mergeConfig for the PvP fields', () => {
	it('keeps the stored limit when the new one is out of range, and takes the others', () => {
		const stored = mergeConfig(DEFAULT_CONFIG, {
			pvpLimits: { animatingHoldMilliseconds: 60_000 },
		})
		expect(stored.pvpLimits.animatingHoldMilliseconds).toBe(60_000)
		const next = mergeConfig(stored, {
			pvpLimits: { animatingHoldMilliseconds: 5, awayBudgetMilliseconds: 10_000 },
		})
		expect(next.pvpLimits).toEqual({
			...DEFAULT_PVP_LIMITS,
			animatingHoldMilliseconds: 60_000,
			awayBudgetMilliseconds: 10_000,
		})
		expect(mergePvpLimits(stored.pvpLimits, undefined)).toBe(stored.pvpLimits)
	})

	it('keeps the limits when the update has none', () => {
		expect(
			mergeConfig(DEFAULT_CONFIG, { chatEnabled: false }).pvpLimits,
		).toEqual(DEFAULT_PVP_LIMITS)
	})

	it.each([
		['1.2.3', '1.2.3'],
		['10.20.30', '10.20.30'],
		['', ''],
	])('takes the minimum version %j', (given, kept) => {
		const set = mergeConfig(DEFAULT_CONFIG, { pvpMinVersion: '9.9.9' })
		expect(mergeConfig(set, { pvpMinVersion: given }).pvpMinVersion).toBe(kept)
	})

	it.each(['1.2', 'v1.2.3', '1.2.3-beta', '1.2.x', ' 1.2.3', 123, null, true])(
		'keeps the stored minimum version when given %j',
		(given) => {
			const set = mergeConfig(DEFAULT_CONFIG, { pvpMinVersion: '1.0.0' })
			expect(mergeConfig(set, { pvpMinVersion: given }).pvpMinVersion).toBe(
				'1.0.0',
			)
		},
	)

	it('starts with no minimum version', () => {
		expect(DEFAULT_CONFIG.pvpMinVersion).toBe('')
	})

	it('shows a client neither the limits nor the minimum version', () => {
		const shown = clientConfig(
			mergeConfig(DEFAULT_CONFIG, { pvpMinVersion: '1.0.0' }),
		) as { [key: string]: unknown }
		expect('pvpLimits' in shown).toBe(false)
		expect('pvpMinVersion' in shown).toBe(false)
	})
})
