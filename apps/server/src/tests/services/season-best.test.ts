import { describe, expect, it } from 'vitest'
import {
	seasonBestColumns,
	seasonBestOut,
} from '../../features/ratings/season-best.js'

const none = {
	seasonBest: null,
	seasonBestLen: null,
	seasonBestRev: null,
	seasonBestText: null,
}

describe('seasonBestColumns', () => {
	it('stores a PvP score as text, array length and array from the top', () => {
		expect(seasonBestColumns('MultiplayerPvP', '20.5,2')).toEqual({
			seasonBest: null,
			seasonBestLen: 2,
			seasonBestRev: [2, 20.5],
			seasonBestText: '20.5,2',
		})
	})

	it('keeps the old bigint column when the score is one whole number', () => {
		expect(seasonBestColumns('MultiplayerPvP', '1000000000000000')).toEqual({
			seasonBest: 1e15,
			seasonBestLen: 1,
			seasonBestRev: [1e15],
			seasonBestText: '1000000000000000',
		})
	})

	it('reads a score stored in Nakama as an old number', () => {
		expect(seasonBestColumns('MultiplayerPvP', 1e15).seasonBestText).toBe(
			'1000000000000000',
		)
	})

	it('stores a time as the bigint column only', () => {
		expect(seasonBestColumns('MultiplayerSPDRN', 95_000)).toEqual({
			...none,
			seasonBest: 95_000,
		})
	})

	it('stores nothing for no value, bad text or a mod without a board', () => {
		expect(seasonBestColumns('MultiplayerPvP', null)).toEqual(none)
		expect(seasonBestColumns('MultiplayerPvP', 'nope')).toEqual(none)
		expect(seasonBestColumns('Other', 5)).toEqual(none)
	})
})

describe('seasonBestOut', () => {
	it('is the score text when the row has it, else the number', () => {
		expect(seasonBestOut({ seasonBest: null, seasonBestText: '20,2' })).toBe(
			'20,2',
		)
		expect(seasonBestOut({ seasonBest: 95_000, seasonBestText: null })).toBe(
			95_000,
		)
		expect(seasonBestOut({ seasonBest: null, seasonBestText: null })).toBeNull()
		expect(seasonBestOut({ seasonBest: '95000', seasonBestText: null })).toBe(
			95_000,
		)
	})
})
