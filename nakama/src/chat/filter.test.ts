import { describe, expect, it } from 'vitest'
import { isAllowlisted, normalizeForAllowlist, obscenityMatches } from './filter'

describe('the chat allowlist', () => {
	it('keys a message the way the API did', () => {
		expect(normalizeForAllowlist('  GG! ')).toBe('gg')
		expect(normalizeForAllowlist('?!')).toBe('?!')
		expect(normalizeForAllowlist('   ')).toBeNull()
	})

	it('matches a listed message however it is cased or punctuated', () => {
		expect(isAllowlisted('Good luck!', ['good luck'])).toBe(true)
		expect(isAllowlisted('good luck have fun', ['good luck'])).toBe(false)
		expect(isAllowlisted('', [''])).toBe(false)
	})
})

describe('the local word filter', () => {
	it('passes a clean message', () => {
		expect(obscenityMatches('nice flush')).toEqual([])
	})

	it('names the word it blocked', () => {
		const [match] = obscenityMatches('you are a fucking cheater')
		expect(match.word).toBe('fuck')
		expect(match.startIndex).toBe(10)
	})
})
