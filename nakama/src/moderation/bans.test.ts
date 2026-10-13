import { describe, expect, it } from 'vitest'
import { activeBan, bansFromList, withBan, withoutBan, withoutExpired } from './bans'

describe('bans', () => {
	it('keeps the longest ban of each type', () => {
		let bans = withBan({}, 'queue', { banId: 'a', expiresAt: 100, reason: '' })
		bans = withBan(bans, 'queue', { banId: 'b', expiresAt: 50, reason: '' })
		expect(bans.queue!.banId).toBe('a')
		bans = withBan(bans, 'queue', { banId: 'c', expiresAt: null, reason: '' })
		expect(bans.queue!.banId).toBe('c')
	})

	it('expires and lifts', () => {
		const bans = bansFromList([
			{ type: 'chat', banId: 'a', expiresAt: 100, reason: '' },
			{ type: 'account', banId: 'b', expiresAt: null, reason: '' },
			{ type: 'nonsense', banId: 'c', expiresAt: null, reason: '' },
		])
		expect(activeBan(bans, 'chat', 99)).not.toBeNull()
		expect(activeBan(bans, 'chat', 100)).toBeNull()
		expect(Object.keys(withoutExpired(bans, 200))).toEqual(['account'])
		expect(withoutExpired(bans, 0)).toBe(bans)
		expect(withoutBan(bans, 'b').account).toBeUndefined()
	})
})
