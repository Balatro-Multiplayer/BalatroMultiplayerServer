import { describe, expect, it } from 'vitest'
import { defaultProfile, writeProfile } from '../player/profile'
import { fakeNk } from '../testing/fake_nk'
import { joinInfoOf } from './match'

const USER = '11111111-1111-4111-8111-111111111111'
const presence = { userId: USER, sessionId: 's', username: 'nkuser', node: 'n' }
const meta = { displayName: 'Sent', preferredJoker: 'j_joker', mods: '["A-1"]' }

describe('joinInfoOf', () => {
	it('takes the metadata from a player who logged in through the API', () => {
		const nk = fakeNk()
		expect(joinInfoOf(nk as any, presence, meta)).toEqual({ displayName: 'Sent', preferredJoker: 'j_joker', mods: ['A-1'] })
		// A profile holding only the mirrored consent doesn't change that.
		writeProfile(nk as any, USER, { ...defaultProfile('nkuser'), tosAcceptedVersion: 1 })
		expect(joinInfoOf(nk as any, presence, meta).displayName).toBe('Sent')
	})

	it('takes the name and joker from a profile that has logged in through session_init', () => {
		const nk = fakeNk()
		writeProfile(nk as any, USER, { ...defaultProfile('Alice'), preferredJoker: 'j_mime', mods: ['B-2'], nakamaLogin: true })
		expect(joinInfoOf(nk as any, presence, meta)).toEqual({ displayName: 'Alice', preferredJoker: 'j_mime', mods: ['A-1'] })
		expect(joinInfoOf(nk as any, presence, {}).mods).toEqual(['B-2'])
	})
})
