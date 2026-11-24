import { describe, expect, it } from 'vitest'
import {
	DEFAULT_CONFIG,
	instantRangesOf,
	mergeConfig,
	writeConfig,
} from '../config'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import {
	NO_RANGE,
	rangeFor,
	rpcQueueRanges,
	stampRating,
} from './instant_queue'

const RANGE = {
	floor: 1200,
	ceiling: 400,
	floorMultiplier: 1.5,
	ceilingMultiplier: 1,
}

describe('instantRangesOf', () => {
	it('keeps valid ranges and drops invalid ones', () => {
		expect(
			instantRangesOf({
				'M:standard': RANGE,
				'M:floor_only': {
					floor: 900,
					ceiling: null,
					floorMultiplier: 1,
					ceilingMultiplier: 1,
				},
				'M:empty': {
					floor: null,
					ceiling: null,
					floorMultiplier: 1,
					ceilingMultiplier: 1,
				},
				'M:crossed': {
					floor: 500,
					ceiling: 500,
					floorMultiplier: 1,
					ceilingMultiplier: 1,
				},
				'M:fraction': {
					floor: 500.5,
					ceiling: null,
					floorMultiplier: 1,
					ceilingMultiplier: 1,
				},
				'M:slow': {
					floor: 500,
					ceiling: null,
					floorMultiplier: 0,
					ceilingMultiplier: 1,
				},
				'has space': RANGE,
				'M:junk': 7,
			}),
		).toEqual({
			'M:standard': RANGE,
			'M:floor_only': {
				floor: 900,
				ceiling: null,
				floorMultiplier: 1,
				ceilingMultiplier: 1,
			},
		})
	})

	it('refuses a value that is not a map', () => {
		expect(instantRangesOf(undefined)).toBeNull()
		expect(instantRangesOf([RANGE])).toBeNull()
		expect(instantRangesOf('x')).toBeNull()
	})
})

describe('server config', () => {
	it('takes the ranges from the API push and keeps them across a push without them', () => {
		const pushed = mergeConfig(DEFAULT_CONFIG, {
			instantQueue: { 'M:standard': RANGE },
		})
		expect(pushed.instantQueue).toEqual({ 'M:standard': RANGE })
		expect(mergeConfig(pushed, { chatEnabled: false }).instantQueue).toEqual({
			'M:standard': RANGE,
		})
		expect(mergeConfig(pushed, { instantQueue: {} }).instantQueue).toEqual({})
		expect(mergeConfig(pushed, { instantQueue: 'bad' }).instantQueue).toEqual({
			'M:standard': RANGE,
		})
	})
})

describe('rangeFor', () => {
	it("is the queue's range, or none", () => {
		const config = mergeConfig(DEFAULT_CONFIG, {
			instantQueue: { 'M:standard': RANGE },
		})
		expect(rangeFor(config, 'M', 'standard')).toEqual(RANGE)
		expect(rangeFor(config, 'M', 'other')).toBe(NO_RANGE)
		expect(rangeFor(config, 'N', 'standard')).toBe(NO_RANGE)
	})
})

describe('queue_ranges', () => {
	const call = (nk: any, body: object, ctx = playerCtx('u1')) =>
		JSON.parse(rpcQueueRanges(ctx, fakeLogger, nk, JSON.stringify(body)))

	it('answers a player with the range of the queue', () => {
		const nk = fakeNk()
		writeConfig(
			nk as any,
			mergeConfig(DEFAULT_CONFIG, { instantQueue: { 'M:standard': RANGE } }),
		)
		expect(call(nk, { modId: 'M', mode: 'standard' })).toEqual(RANGE)
		expect(call(nk, { modId: 'M', mode: 'other' })).toEqual(NO_RANGE)
	})

	it('needs a player and a queue', () => {
		const nk = fakeNk()
		expect(() =>
			call(nk, { modId: 'M', mode: 'standard' }, serverCtx()),
		).toThrow()
		expect(() => call(nk, { modId: 'M' })).toThrow()
		expect(() => call(nk, { modId: 'M x', mode: 'standard' })).toThrow()
	})
})

describe('stampRating', () => {
	it("sets the ticket's rating to the stored one, and 600 for an unrated player", () => {
		const nk = fakeNk()
		writeConfig(nk as any, { ...DEFAULT_CONFIG, season: 2 })
		nk.storageWrite([
			{
				collection: RATINGS_COLLECTION,
				key: 'M:standard:2',
				userId: 'u1',
				value: {
					rating: 1534,
					wins: 3,
					losses: 1,
					gamesPlayed: 9,
					seasonBest: null,
					lastMatchAt: Date.now(),
				},
			},
		])
		const forged = { numericProperties: { rating: 3000 }, stringProperties: {} }
		stampRating(nk as any, 'u1', forged, 'M', 'standard')
		expect(forged.numericProperties.rating).toBe(1534)
		const bare: { [key: string]: unknown } = {}
		stampRating(nk as any, 'u2', bare, 'M', 'standard')
		expect(bare.numericProperties).toEqual({ rating: 600 })
	})
})
