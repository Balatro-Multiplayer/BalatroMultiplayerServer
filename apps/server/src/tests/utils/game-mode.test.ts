import { describe, expect, it } from 'vitest'
import { isRankedGameMode } from '../../shared/utils/game-mode.js'

describe('isRankedGameMode', () => {
	it('is true for a ranked: game mode only', () => {
		expect(isRankedGameMode('ranked:solo')).toBe(true)
		expect(isRankedGameMode('casual')).toBe(false)
		expect(isRankedGameMode('unranked:solo')).toBe(false)
	})
})
