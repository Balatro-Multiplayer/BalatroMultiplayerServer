import { describe, expect, it } from 'vitest'
import { stakePopularity } from '../../features/stats/stake-popularity.js'

describe('stakePopularity', () => {
	it('keeps each mod in its own buckets and sums them', () => {
		const result = stakePopularity([
			{ modId: 'MultiplayerSPDRN', gameMode: 'spdrn_white_stake_triple', count: 3 },
			{ modId: 'MultiplayerSPDRN', gameMode: 'spdrn_gold_stake_single', count: 2 },
			{ modId: 'MultiplayerPvP', gameMode: 'spdrn_white_stake_triple', count: 5 },
			{ modId: 'MultiplayerPvP', gameMode: 'attrition', count: 7 },
		])
		expect(result.byMod).toEqual({
			MultiplayerSPDRN: { 'White Stake': 3, 'Gold Stake': 2, Other: 0 },
			MultiplayerPvP: { 'White Stake': 5, 'Gold Stake': 0, Other: 7 },
		})
		expect(result.buckets).toEqual({ 'White Stake': 8, 'Gold Stake': 2, Other: 7 })
		expect(result.coarse).toBe(true)
	})

	it('answers empty buckets with no matches', () => {
		expect(stakePopularity([])).toEqual({ buckets: { 'White Stake': 0, 'Gold Stake': 0, Other: 0 }, byMod: {}, coarse: true })
	})
})
