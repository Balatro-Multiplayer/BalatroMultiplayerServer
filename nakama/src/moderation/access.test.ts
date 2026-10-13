import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../config'
import { banMessage, chatBanRefusal, lobbyCreateRefusal, playRefusal, queueRefusal } from './access'

const ban = (expiresAt: number | null, reason = '') => ({ banId: 'b', expiresAt, reason })

describe('access gates', () => {
	it('let testers alone play in testing mode', () => {
		const testing = { ...DEFAULT_CONFIG, testingMode: true }
		expect(playRefusal(testing, [])).toMatch(/testing mode/)
		expect(playRefusal(testing, ['tester'])).toBeNull()
		expect(playRefusal(DEFAULT_CONFIG, [])).toBeNull()
	})
	it('refuse lobby creation while it is switched off', () => {
		expect(lobbyCreateRefusal({ ...DEFAULT_CONFIG, lobbyCreationEnabled: false }, ['tester'])).toMatch(/disabled/)
		expect(lobbyCreateRefusal(DEFAULT_CONFIG, [])).toBeNull()
	})
	it('refuse each queue while switched off, and queue bans until they run out', () => {
		expect(queueRefusal({ ...DEFAULT_CONFIG, rankedEnabled: false }, [], {}, true, 0)).toMatch(/Ranked/)
		expect(queueRefusal({ ...DEFAULT_CONFIG, rankedEnabled: false }, [], {}, false, 0)).toBeNull()
		expect(queueRefusal({ ...DEFAULT_CONFIG, casualQueueEnabled: false }, [], {}, false, 0)).toMatch(/Casual/)
		const bans = { queue: ban(100, 'smurfing') }
		expect(queueRefusal(DEFAULT_CONFIG, [], bans, false, 50)).toBe(
			'You are banned from matchmaking until 1970-01-01T00:00:00.100Z: smurfing',
		)
		expect(queueRefusal(DEFAULT_CONFIG, [], bans, false, 100)).toBeNull()
		expect(queueRefusal(DEFAULT_CONFIG, [], { chat: ban(null) }, false, 0)).toBeNull()
	})
	it('refuse chat to the chat-banned', () => {
		expect(chatBanRefusal({ chat: ban(null) }, 0)).toBe('You are banned from chat')
		expect(chatBanRefusal({ queue: ban(null) }, 0)).toBeNull()
	})
	it('word permanent bans without a time', () => {
		expect(banMessage('Account banned', ban(null, 'cheating'))).toBe('Account banned: cheating')
	})
})
