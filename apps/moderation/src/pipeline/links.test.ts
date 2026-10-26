import { describe, expect, it } from 'vitest'
import { hasUnapprovedLink, parseApprovedDomains } from './links.js'

const APPROVED = parseApprovedDomains('# ok\nyoutube.com\ntenor.com\n')

describe('parseApprovedDomains', () => {
	it('parses hosts, skipping comments/blanks, stripping scheme/www/path', () => {
		expect(
			parseApprovedDomains(
				'# domains\nyoutube.com\n\nhttps://www.tenor.com/view\n',
			),
		).toEqual(['youtube.com', 'tenor.com'])
	})
})

describe('hasUnapprovedLink', () => {
	it('finds an unapproved link inside a message', () => {
		expect(
			hasUnapprovedLink('check this https://evil.example/x lol', APPROVED),
		).toBe(true)
	})

	it('treats every link as unapproved when no domain is approved', () => {
		expect(
			hasUnapprovedLink(
				'https://tenor.com/view/cat-gif',
				parseApprovedDomains(''),
			),
		).toBe(true)
	})

	it('accepts approved domains and their subdomains', () => {
		expect(
			hasUnapprovedLink('https://www.youtube.com/watch?v=abc', APPROVED),
		).toBe(false)
		expect(hasUnapprovedLink('https://tenor.com/view/x', APPROVED)).toBe(false)
	})

	it('flags a mix when any one link is unapproved', () => {
		expect(
			hasUnapprovedLink(
				'a https://tenor.com/g and https://spam.co/x',
				APPROVED,
			),
		).toBe(true)
	})

	it('matches www. links without a scheme', () => {
		expect(hasUnapprovedLink('go to www.spam.co now', APPROVED)).toBe(true)
	})

	it('ignores link-free messages (no false positives on slang)', () => {
		expect(hasUnapprovedLink('gg wp ez', APPROVED)).toBe(false)
		expect(hasUnapprovedLink('good game 1.5.2 patch', APPROVED)).toBe(false)
	})
})
