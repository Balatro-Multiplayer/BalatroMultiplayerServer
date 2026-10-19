import { describe, expect, it } from 'vitest'
import { defaultProfile, PLAYER_COLLECTION, readProfile, writeProfile } from '../player/profile'
import { A, B, C } from '../testing/achievement_fixtures'
import { fakeLogger, fakeNk, serverCtx, type FakeNk } from '../testing/fake_nk'
import { emptyProgress } from './progress'
import { keepsJoker, parseCursor, rpcAdminAvatarsReset } from './reset'
import { readProgress, writeProgress } from './storage'

function players(): FakeNk {
	// profileChanged keeps the account's display name in step.
	const nk = fakeNk({ accountGetId: (id: string) => ({ user: { id, displayName: id } }), accountUpdateId: () => undefined })
	const profile = (id: string, preferredJoker: string, privileges: string[]) =>
		writeProfile(nk as any, id, { ...defaultProfile(id), preferredJoker, privileges })
	profile(A, 'j_baron', []) // earned: reset
	profile(B, 'j_mime', ['staff']) // privilege still held: kept
	profile(C, 'j_jolly', []) // default: kept
	for (const id of [A, B]) writeProgress(nk as any, id, { ...emptyProgress(), unlocked: ['j_baron'] })
	return nk
}

const reset = (nk: FakeNk, input: object) => JSON.parse(rpcAdminAvatarsReset(serverCtx(), fakeLogger, nk as any, JSON.stringify(input)))

describe('admin_avatars_reset', () => {
	it('keeps only jokers a player may pick with nothing earned', () => {
		expect(keepsJoker('j_jolly', [])).toBe(true)
		expect(keepsJoker('j_mime', ['staff'])).toBe(true)
		expect(keepsJoker('j_ring_master', ['staff'])).toBe(true)
		expect(keepsJoker('j_mime', [])).toBe(false)
		expect(keepsJoker('j_baron', [])).toBe(false)
		expect(keepsJoker('j_not_a_joker', [])).toBe(false)
	})

	it('counts without changing anything on a dry run', () => {
		const nk = players()
		const first = reset(nk, { dryRun: true })
		expect(first).toEqual({ dryRun: true, checked: 3, jokersReset: 1, progressDeleted: 0, cursor: 'progress:' })
		const second = reset(nk, { dryRun: true, cursor: first.cursor })
		expect(second).toEqual({ dryRun: true, checked: 0, jokersReset: 0, progressDeleted: 2, cursor: '' })
		expect(readProfile(nk as any, A)!.profile.preferredJoker).toBe('j_baron')
		expect(readProgress(nk as any, A)).not.toBeNull()
		expect(nk.notifications).toEqual([])
	})

	it('resets jokers, then deletes progress, page by page', () => {
		const nk = players()
		const first = reset(nk, {})
		expect(first).toMatchObject({ dryRun: false, jokersReset: 1, cursor: 'progress:' })
		expect(readProfile(nk as any, A)!.profile.preferredJoker).toBe('j_joker')
		expect(readProfile(nk as any, B)!.profile.preferredJoker).toBe('j_mime')
		expect(readProfile(nk as any, C)!.profile.preferredJoker).toBe('j_jolly')
		// The changed player's client is told.
		expect(nk.notifications.map((n) => n.userId)).toEqual([A])
		const second = reset(nk, { cursor: first.cursor })
		expect(second).toMatchObject({ progressDeleted: 2, cursor: '' })
		expect(readProgress(nk as any, A)).toBeNull()
		expect(readProgress(nk as any, B)).toBeNull()
	})

	it('follows Nakama cursors, restarting the progress listing after deleting', () => {
		const nk = players()
		const calls: { collection: string; cursor: string }[] = []
		const list = nk.storageList
		nk.storageList = (userId: string | null, collection: string, limit: number, cursor: string) => {
			calls.push({ collection, cursor })
			const page = list(userId, collection, limit)
			// Hand out one object per page, with a cursor while more remain.
			return { objects: page.objects.slice(0, 1), cursor: page.objects.length > 1 ? 'next' : '' }
		}
		expect(reset(nk, {}).cursor).toBe('profiles:next')
		expect(reset(nk, { cursor: 'profiles:next' }).cursor).toBe('profiles:next')
		expect(reset(nk, { cursor: 'progress:' }).cursor).toBe('progress:')
		expect(reset(nk, { cursor: 'progress:' }).cursor).toBe('')
		expect(calls[1]).toEqual({ collection: PLAYER_COLLECTION, cursor: 'next' })
		expect(readProgress(nk as any, A)).toBeNull()
		expect(readProgress(nk as any, B)).toBeNull()
	})

	it('rejects a bad cursor or dryRun', () => {
		expect(parseCursor(undefined)).toEqual({ phase: 'profiles', cursor: '' })
		expect(parseCursor('progress:abc')).toEqual({ phase: 'progress', cursor: 'abc' })
		const nk = players()
		expect(() => reset(nk, { cursor: 'nope' })).toThrow(/Invalid cursor/)
		expect(() => reset(nk, { cursor: 7 })).toThrow(/Invalid cursor/)
		expect(() => reset(nk, { dryRun: 'yes' })).toThrow(/dryRun/)
		nk.storageList = () => {
			throw new Error('Malformed cursor was used')
		}
		expect(() => reset(nk, { cursor: 'profiles:forged' })).toThrow(/Invalid cursor/)
	})

	it('is server-only', () => {
		expect(() => rpcAdminAvatarsReset({ ...serverCtx(), userId: A } as any, fakeLogger, players() as any, '{}')).toThrow()
	})
})
