import { describe, expect, it } from 'vitest'
import { PVP_MOD_ID, pvpVersionOf, versionOutliers } from './pvp_version'

describe('pvpVersionOf', () => {
	it('takes the X.Y.Z prefix of the PvP entry', () => {
		expect(pvpVersionOf(['Steamodded-1.0.0~BETA-1814a', 'MultiplayerPvP-1.0.3'])).toBe('1.0.3')
		expect(pvpVersionOf(['MultiplayerPvP-1.0.3-beta.2'])).toBe('1.0.3')
		expect(pvpVersionOf(['MultiplayerPvP-v1.2.0'])).toBe('1.2.0')
	})

	it('is empty when PvP is not reported', () => {
		expect(pvpVersionOf(['Steamodded-1.0.0', 'MultiplayerPvPExtra-9.9.9'])).toBe('')
		expect(pvpVersionOf([])).toBe('')
	})

	it('keeps an unreadable version as it was reported', () => {
		expect(pvpVersionOf([PVP_MOD_ID + '-UNK'])).toBe('UNK')
	})
})

describe('versionOutliers', () => {
	it('is empty when every version matches', () => {
		expect(versionOutliers({ a: '1.0.3', b: '1.0.3' })).toEqual([])
	})

	it('names the players off the most common version', () => {
		expect(versionOutliers({ a: '1.0.3', b: '1.0.2', c: '1.0.3' })).toEqual(['b'])
	})

	it('keeps the newer version on a tie', () => {
		expect(versionOutliers({ a: '1.0.2', b: '1.0.10' })).toEqual(['a'])
		expect(versionOutliers({ a: '1.0.3', b: '' })).toEqual(['b'])
	})
})
