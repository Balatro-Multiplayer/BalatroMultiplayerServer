import { describe, expect, it } from 'vitest'
import { INTEGRITY_REQUIRED } from '../integrity'
import { isStandingRefusal, queueRefusalMessage, refusedMods, standingRefusal } from './queue_refusal'

describe('queue refusals', () => {
	it('word each code, listing the mods', () => {
		expect(queueRefusalMessage({ code: 'access_denied', message: 'Banned.' })).toBe('Banned.')
		expect(queueRefusalMessage({ code: 'integrity_required' })).toBe(INTEGRITY_REQUIRED)
		expect(queueRefusalMessage({ code: 'mods_not_allowed', mods: ['X', 'Y'] })).toBe(
			"These mods aren't allowed in matchmaking: X, Y",
		)
		expect(queueRefusalMessage({ code: 'mods_unreported' })).toMatch(/reported its mods/)
	})
	it('come from a standing of none only', () => {
		expect(standingRefusal({ standing: 'valid', disallowed: [], reason: null })).toBeNull()
		expect(standingRefusal({ standing: 'verified', disallowed: [], reason: null })).toBeNull()
		expect(standingRefusal({ standing: 'none', disallowed: ['X'], reason: 'mods_not_allowed' })).toEqual({
			code: 'mods_not_allowed',
			mods: ['X'],
		})
		expect(standingRefusal({ standing: 'none', disallowed: [], reason: 'unreported' })).toEqual({ code: 'mods_unreported' })
	})
	it('tell the standing ones apart, and name their mods', () => {
		expect(isStandingRefusal({ code: 'mods_unreported' })).toBe(true)
		expect(isStandingRefusal({ code: 'integrity_required' })).toBe(false)
		expect(refusedMods({ code: 'mods_not_allowed', mods: ['X'] })).toEqual(['X'])
		expect(refusedMods({ code: 'access_denied', message: '' })).toEqual([])
	})
})
