import { describe, expect, it } from 'vitest'
import { defaultProfile, PLAYER_COLLECTION, readProfile, writeProfile } from '../player/profile'
import { A, B, C } from '../testing/achievement_fixtures'
import { fakeLogger, fakeNk, serverCtx, type FakeNk } from '../testing/fake_nk'
import { emptyProgress } from './progress'
import { keepsJoker, rpcAdminAvatarsReset } from './reset'
import { readProgress, writeProgress } from './storage'

function players(): FakeNk {
	// profileChanged keeps the account's display name in step.
	const nk = fakeNk({ accountGetId: (id: string) => ({ user: { id, displayName: id } }), accountUpdateId: () => undefined })
	const profile = (id: string, preferredJoker: string, privileges: string[]) =>
		writeProfile(nk as any, id, { ...defaultProfile(id), preferredJoker, privileges })
	profile(A, 'j_baron', []) // not earned: reset
	profile(B, 'j_baron', []) // earned: kept
	profile(C, 'j_mime', ['staff']) // privilege still held: kept
	writeProgress(nk as any, B, { ...emptyProgress(), unlocked: ['j_baron'] })
	return nk
}

const reset = (nk: FakeNk, input: object) => JSON.parse(rpcAdminAvatarsReset(serverCtx(), fakeLogger, nk as any, JSON.stringify(input)))

describe('admin_avatars_reset', () => {
	it('keeps only jokers a player may pick', () => {
		expect(keepsJoker('j_jolly', [], [])).toBe(true)
		expect(keepsJoker('j_mime', ['staff'], [])).toBe(true)
		expect(keepsJoker('j_ring_master', ['staff'], [])).toBe(true)
		expect(keepsJoker('j_baron', [], ['j_baron'])).toBe(true)
		expect(keepsJoker('j_mime', [], [])).toBe(false)
		expect(keepsJoker('j_baron', [], [])).toBe(false)
		expect(keepsJoker('j_not_a_joker', [], [])).toBe(false)
	})

	it('counts without changing anything on a dry run', () => {
		const nk = players()
		expect(reset(nk, { dryRun: true })).toEqual({ dryRun: true, checked: 3, jokersReset: 1, cursor: '' })
		expect(readProfile(nk as any, A)!.profile.preferredJoker).toBe('j_baron')
		expect(nk.notifications).toEqual([])
	})

	it('resets the jokers a player may not pick and keeps their progress', () => {
		const nk = players()
		const before = readProgress(nk as any, B)
		expect(reset(nk, {})).toMatchObject({ dryRun: false, jokersReset: 1, cursor: '' })
		expect(readProfile(nk as any, A)!.profile.preferredJoker).toBe('j_joker')
		expect(readProfile(nk as any, B)!.profile.preferredJoker).toBe('j_baron')
		expect(readProfile(nk as any, C)!.profile.preferredJoker).toBe('j_mime')
		expect(readProgress(nk as any, B)).toEqual(before)
		// The changed player's client is told.
		expect(nk.notifications.map((n) => n.userId)).toEqual([A])
	})

	it('follows Nakama cursors', () => {
		const nk = players()
		const calls: { collection: string; cursor: string }[] = []
		const list = nk.storageList
		nk.storageList = (userId: string | null, collection: string, limit: number, cursor: string) => {
			calls.push({ collection, cursor })
			const page = list(userId, collection, limit)
			return { objects: page.objects.slice(0, 1), cursor: 'next' }
		}
		expect(reset(nk, {}).cursor).toBe('next')
		expect(reset(nk, { cursor: 'next' }).cursor).toBe('next')
		expect(calls[1]).toEqual({ collection: PLAYER_COLLECTION, cursor: 'next' })
	})

	it('rejects a bad cursor or dryRun', () => {
		const nk = players()
		expect(() => reset(nk, { cursor: 7 })).toThrow(/Invalid cursor/)
		expect(() => reset(nk, { dryRun: 'yes' })).toThrow(/dryRun/)
		nk.storageList = () => {
			throw new Error('Malformed cursor was used')
		}
		expect(() => reset(nk, { cursor: 'forged' })).toThrow(/Invalid cursor/)
	})

	it('is server-only', () => {
		expect(() => rpcAdminAvatarsReset({ ...serverCtx(), userId: A } as any, fakeLogger, players() as any, '{}')).toThrow()
	})
})
