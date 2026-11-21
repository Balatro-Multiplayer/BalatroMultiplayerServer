import { describe, expect, it } from 'vitest'
import { closeCodeProblem, setupProblem } from './startup.js'

describe('setupProblem', () => {
	it.each([
		[{ code: 'TokenInvalid' }, 'token'],
		[{ status: 401 }, 'token'],
		[{ status: 403, code: 50001 }, 'applications.commands'],
		[{ status: 404, code: 10004 }, 'DISCORD_GUILD_ID'],
	])('names what to fix for %j', (err, hint) => {
		expect(setupProblem(err)).toContain(hint)
	})

	it.each([
		[new Error('getaddrinfo ENOTFOUND discord.com')],
		[{ status: 500 }],
		[{ status: 429 }],
		[null],
	])('leaves %j to a restart', (err) => {
		expect(setupProblem(err)).toBeNull()
	})
})

describe('closeCodeProblem', () => {
	it('names the missing intent', () => {
		expect(closeCodeProblem(4014)).toContain('Server Members Intent')
	})

	it('ignores codes discord.js reconnects after', () => {
		expect(closeCodeProblem(1006)).toBeNull()
		expect(closeCodeProblem(4000)).toBeNull()
	})
})
