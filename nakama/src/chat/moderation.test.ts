import { describe, expect, it } from 'vitest'
import { decideModerationOutcome } from './moderation'

const ok = (body: unknown, status = 200) => ({ status, body })

describe('decideModerationOutcome', () => {
	it('allows an allow verdict, ignoring any publishText', () => {
		expect(decideModerationOutcome(ok({ verdict: 'allow' }))).toEqual({ allowed: true, review: false })
		expect(decideModerationOutcome(ok({ verdict: 'allow', publishText: 'gg' }))).toEqual({ allowed: true, review: false })
	})
	it('blocks a reject as moderated, with its band', () => {
		expect(decideModerationOutcome(ok({ verdict: 'reject', band: 'slur' }))).toEqual({
			allowed: false,
			reason: 'moderated',
			band: 'slur',
		})
	})
	it('fails closed on anything it cannot read', () => {
		for (const attempt of [null, ok({ verdict: 'allow' }, 500), ok({ verdict: 'allow' }, 429), ok('x'), ok({ verdict: 'maybe' })])
			expect(decideModerationOutcome(attempt)).toEqual({ allowed: false, reason: 'unavailable' })
	})
	it('does not blame the player when the service model is down', () => {
		expect(decideModerationOutcome(ok({ verdict: 'reject', band: 'guard_unavailable' }))).toEqual({
			allowed: false,
			reason: 'unavailable',
		})
	})
})
