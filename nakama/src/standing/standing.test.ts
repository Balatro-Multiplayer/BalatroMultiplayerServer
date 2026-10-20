import { describe, expect, it } from 'vitest'
import { meetsRequirement, queueAllowed, requiredStandingFor, standingOf } from './standing'

const ALLOWED = ['Steamodded', 'MultiplayerAPI']
const report = (mods: string[]) => ({ mods, reportedAt: 0 })
const ALL_ALLOWED = report(['MultiplayerAPI-0.1.2'])
const DISALLOWED = report(['MultiplayerAPI-0.1.2', 'Cryptid-0.5.3'])

describe('standingOf', () => {
	it('verified passes any mods, enforced or not', () => {
		for (const enforced of [true, false])
			for (const r of [ALL_ALLOWED, DISALLOWED, null])
				expect(standingOf({ verified: true, report: r, allowedIds: ALLOWED, enforced })).toEqual({
					standing: 'verified',
					disallowed: [],
					reason: null,
				})
	})
	it('unverified is valid for anything while not enforced', () => {
		for (const r of [ALL_ALLOWED, DISALLOWED, null])
			expect(standingOf({ verified: false, report: r, allowedIds: ALLOWED, enforced: false }).standing).toBe('valid')
	})
	it('unverified and enforced: valid only with an all-allowed report', () => {
		const of = (r: any) => standingOf({ verified: false, report: r, allowedIds: ALLOWED, enforced: true })
		expect(of(ALL_ALLOWED)).toEqual({ standing: 'valid', disallowed: [], reason: null })
		expect(of(DISALLOWED)).toEqual({ standing: 'none', disallowed: ['Cryptid'], reason: 'mods_not_allowed' })
		expect(of(null)).toEqual({ standing: 'none', disallowed: [], reason: 'unreported' })
		// An empty report (a vanilla-only client) is a report.
		expect(of(report([])).standing).toBe('valid')
	})
})

describe('queueAllowed / meetsRequirement / requiredStandingFor', () => {
	it('follows the table: none nothing, valid casual, verified everything', () => {
		expect([queueAllowed('none', 'casual'), queueAllowed('none', 'ranked')]).toEqual([false, false])
		expect([queueAllowed('valid', 'casual'), queueAllowed('valid', 'ranked')]).toEqual([true, false])
		expect([queueAllowed('verified', 'casual'), queueAllowed('verified', 'ranked')]).toEqual([true, true])
	})
	it('orders the standings', () => {
		expect(meetsRequirement('verified', 'valid')).toBe(true)
		expect(meetsRequirement('valid', 'valid')).toBe(true)
		expect(meetsRequirement('none', 'valid')).toBe(false)
		expect(meetsRequirement('valid', 'verified')).toBe(false)
	})
	it('asks verified only of a ranked game while ranked needs the launcher', () => {
		expect(requiredStandingFor(true, true)).toBe('verified')
		expect(requiredStandingFor(true, false)).toBe('valid')
		expect(requiredStandingFor(false, true)).toBe('valid')
	})
})
