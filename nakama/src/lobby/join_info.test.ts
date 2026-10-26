import { describe, expect, it } from 'vitest'
import { emptyProgress } from '../achievements/progress'
import { writeProgress } from '../achievements/storage'
import { defaultProfile, writeProfile } from '../player/profile'
import { writeModReport } from '../standing/storage'
import { fakeNk, settingsFor } from '../testing/fake_nk'
import { joinInfoOf } from './match'

const USER = '11111111-1111-4111-8111-111111111111'
const presence = { userId: USER, sessionId: 's', username: 'nkuser', node: 'n' }
const meta = { displayName: 'Sent', preferredJoker: 'j_perkeo', mods: '["A-1"]' }

describe('joinInfoOf', () => {
	it('takes the metadata from a player who logged in through the API', () => {
		const nk = fakeNk()
		// The joker is never the one the metadata claims. No report this session: none.
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta)).toEqual({ displayName: 'Sent', preferredJoker: 'j_joker', mods: ['A-1'], standing: 'none' })
		// A profile holding only the mirrored consent doesn't change that.
		writeProfile(nk as any, USER, { ...defaultProfile('nkuser'), tosAcceptedVersion: 1 })
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta).displayName).toBe('Sent')
	})

	it('takes the name and joker from a profile that has logged in through session_init', () => {
		const nk = fakeNk()
		writeProfile(nk as any, USER, {
			...defaultProfile('Alice'),
			preferredJoker: 'j_mime',
			privileges: ['staff'],
			mods: ['B-2'],
			nakamaLogin: true,
		})
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta)).toEqual({ displayName: 'Alice', preferredJoker: 'j_mime', mods: ['A-1'], standing: 'none' })
		expect(joinInfoOf(nk as any, settingsFor(), presence, {}).mods).toEqual(['B-2'])
	})

	it("works out the standing itself, whatever the metadata claims", () => {
		const nk = fakeNk()
		expect(joinInfoOf(nk as any, settingsFor(), presence, { ...meta, standing: 'verified' }).standing).toBe('none')
		writeModReport(nk as any, USER, { mods: ['Steamodded-1.0.0~BETA-1814a'], reportedAt: 0 })
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta).standing).toBe('valid')
	})

	it('shows the default joker for a stored pick the player may no longer show', () => {
		const nk = fakeNk()
		writeProfile(nk as any, USER, { ...defaultProfile('Alice'), preferredJoker: 'j_baron', nakamaLogin: true })
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta).preferredJoker).toBe('j_joker')
		writeProgress(nk as any, USER, { ...emptyProgress(), unlocked: ['j_baron'] })
		expect(joinInfoOf(nk as any, settingsFor(), presence, meta).preferredJoker).toBe('j_baron')
	})
})
