import { describe, expect, it } from 'vitest'
import { activeBan, bansFromList, isBan, isPending, startedAt, withBan, withoutBan, withoutExpired } from './bans'

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

	it('keeps a ban that has not started in force and starts it for its full length', () => {
		const pending = { banId: 'p', expiresAt: null, durationMs: 1000, reason: '' }
		expect(isBan(pending)).toBe(true)
		expect(isPending(pending)).toBe(true)
		expect(activeBan({ chat: pending }, 'chat', 10 ** 12)).toBe(pending)
		expect(startedAt(pending, 500)).toEqual({ ...pending, expiresAt: 1500 })
		expect(isPending({ banId: 'x', expiresAt: null, reason: '' })).toBe(false)
		expect(isPending(startedAt(pending, 500))).toBe(false)
	})

	it('carries the length through a sync from Postgres', () => {
		const bans = bansFromList([{ type: 'chat', banId: 'a', expiresAt: null, durationMs: 60000, reason: '' }])
		expect(bans.chat).toEqual({ banId: 'a', expiresAt: null, durationMs: 60000, reason: '' })
	})

	it('compares a ban that has not started by the end it would get now', () => {
		const pending = { banId: 'p', expiresAt: null, durationMs: 1000, reason: '' }
		const running = { banId: 'r', expiresAt: 5000, reason: '' }
		expect(withBan({ chat: running }, 'chat', pending, 100).chat!.banId).toBe('r')
		expect(withBan({ chat: running }, 'chat', { ...pending, durationMs: 9000 }, 100).chat!.banId).toBe('p')
	})

	it('never lets a repeat of a ban that has started put it back to not started', () => {
		const started = { banId: 'p', expiresAt: 1500, durationMs: 1000, reason: '' }
		const again = { banId: 'p', expiresAt: null, durationMs: 1000, reason: '' }
		expect(withBan({ chat: started }, 'chat', again, 600).chat).toBe(started)
	})
})
