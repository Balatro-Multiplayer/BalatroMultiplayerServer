import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../infrastructure/gateways/rating.gateway.js', () => ({
	checkSeasonRollover: vi.fn(),
}))
vi.mock('../../infrastructure/gateways/config.gateway.js', () => ({
	loadConfigFromDb: vi.fn().mockResolvedValue(undefined),
}))

import { rollSeasons } from '../../features/ratings/season.job.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import { checkSeasonRollover } from '../../infrastructure/gateways/rating.gateway.js'

beforeEach(() => {
	vi.mocked(loadConfigFromDb).mockClear()
})

describe('rollSeasons', () => {
	it('reloads the config, pushing the new season to Nakama, after a rollover', async () => {
		vi.mocked(checkSeasonRollover).mockResolvedValue(1)
		expect(await rollSeasons()).toBe(1)
		expect(loadConfigFromDb).toHaveBeenCalledOnce()
	})

	it('leaves the config alone when no season expired', async () => {
		vi.mocked(checkSeasonRollover).mockResolvedValue(0)
		expect(await rollSeasons()).toBe(0)
		expect(loadConfigFromDb).not.toHaveBeenCalled()
	})
})
