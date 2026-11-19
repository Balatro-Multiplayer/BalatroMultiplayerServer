import { describe, expect, it } from 'vitest'
import { clockedBan, banStartsOnLogin } from '../../features/webadmin/ban-clock.js'

const NOW = new Date('2026-06-01T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

describe('clockedBan', () => {
	it('keeps the length of a timed chat, queue or account ban and leaves its end open', () => {
		for (const type of ['chat', 'queue', 'account'] as const)
			expect(clockedBan(type, new Date(NOW.getTime() + DAY), NOW)).toEqual({ expiresAt: null, durationMs: DAY })
	})

	it('rounds the length to a whole minute, as a client sets the end a moment early', () => {
		const end = new Date(NOW.getTime() + 7 * DAY - 1500)
		expect(clockedBan('queue', end, NOW)).toEqual({ expiresAt: null, durationMs: 7 * DAY })
	})

	it('leaves a permanent ban and a username ban as they are', () => {
		expect(clockedBan('chat', null, NOW)).toEqual({ expiresAt: null, durationMs: null })
		expect(clockedBan('username', null, NOW)).toEqual({ expiresAt: null, durationMs: null })
	})
})

describe('banStartsOnLogin', () => {
	it('is true only for a timed ban that has no end yet', () => {
		expect(banStartsOnLogin({ expiresAt: null, durationMs: DAY })).toBe(true)
		expect(banStartsOnLogin({ expiresAt: null, durationMs: null })).toBe(false)
		expect(banStartsOnLogin({ expiresAt: NOW, durationMs: DAY })).toBe(false)
	})
})
