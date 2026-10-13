import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../infrastructure/nakama/moderation-sync.js', () => ({
	banInNakama: vi.fn().mockResolvedValue(undefined),
}))

import { issueBan } from '../../features/webadmin/ban.service.js'
import { insertBan } from '../../infrastructure/gateways/ban.gateway.js'
import { banInNakama } from '../../infrastructure/nakama/moderation-sync.js'

const params = {
	playerId: 'p1',
	banType: 'account' as const,
	expiresAt: null,
	reason: 'cheating',
	issuedBy: 'mod1',
}

const record = {
	id: 'ban-1',
	...params,
	createdAt: new Date(),
	liftedAt: null,
	liftedBy: null,
}

describe('issueBan', () => {
	beforeEach(() => {
		vi.mocked(insertBan).mockResolvedValue(record as never)
	})

	it('records the ban and has Nakama enforce it', async () => {
		await expect(issueBan(params)).resolves.toBe(record)
		expect(insertBan).toHaveBeenCalledWith(params)
		expect(banInNakama).toHaveBeenCalledWith(record)
	})

	it('keeps the recorded ban when Nakama is unreachable', async () => {
		vi.mocked(banInNakama).mockRejectedValueOnce(new Error('down'))
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		await expect(issueBan(params)).resolves.toBe(record)
		expect(err).toHaveBeenCalled()
		err.mockRestore()
	})
})
