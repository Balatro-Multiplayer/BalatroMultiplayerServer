import { describe, expect, it } from 'vitest'
import { CURRENT_LOBBY_COLLECTION, CURRENT_LOBBY_KEY, SYSTEM_USER_ID } from '../lobby/protocol'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk } from '../testing/fake_nk'
import { readBans } from './bans'
import { applyBan, BAN_INDEX_COLLECTION, checkLoginBan, liftBan, purgeDeletedBanIndex } from './enforce'

const U = '11111111-1111-4111-8111-111111111111'

// A Nakama with one account (Steam id 765, one device) seated in a lobby.
function world() {
	const banned: string[] = []
	const signals: { matchId: string; data: any }[] = []
	const nk = fakeNk({
		accountGetId: () => ({ user: { id: U }, customId: '765', devices: [{ id: 'dev1' }] }),
		usersBanId: (ids: string[]) => banned.push(...ids),
		usersUnbanId: (ids: string[]) => ids.forEach((id) => banned.splice(banned.indexOf(id), 1)),
		matchGet: (matchId: string) => ({ matchId }),
		matchSignal: (matchId: string, data: string) => {
			const signal = JSON.parse(data)
			if (signal.type === 'has_player') return 'yes'
			signals.push({ matchId, data: signal })
			return ''
		},
	})
	nk.storageWrite([
		{ collection: CURRENT_LOBBY_COLLECTION, key: CURRENT_LOBBY_KEY, userId: U, value: { matchId: 'm1', code: 'ABC123', modId: 'M' } },
	])
	return { nk, banned, signals }
}

const indexKeys = (nk: ReturnType<typeof fakeNk>) =>
	[...nk.objects.keys()].filter((k) => k.startsWith(BAN_INDEX_COLLECTION + '/')).sort()

describe('applyBan', () => {
	it('bans an account in Nakama, indexes its logins, and takes it out of its lobby', () => {
		const { nk, banned, signals } = world()
		applyBan(nk as any, fakeLogger, U, 'account', { banId: 'b1', expiresAt: null, reason: 'cheating' })
		expect(readBans(nk as any, U).account?.banId).toBe('b1')
		expect(banned).toEqual([U])
		expect(indexKeys(nk)).toEqual([
			`${BAN_INDEX_COLLECTION}/${SYSTEM_USER_ID}/custom:765`,
			`${BAN_INDEX_COLLECTION}/${SYSTEM_USER_ID}/device:dev1`,
		])
		expect(signals).toEqual([
			{ matchId: 'm1', data: { type: 'admin_remove', userId: U, reason: 'banned', onlyIfStarted: false } },
		])
		expect(nk.notifications).toEqual([
			expect.objectContaining({ userId: U, code: NotifyCode.BANNED, persistent: true }),
		])
	})
	it('takes a queue-banned player out of a running game only, without a Nakama ban', () => {
		const { nk, banned, signals } = world()
		applyBan(nk as any, fakeLogger, U, 'queue', { banId: 'q', expiresAt: null, reason: '' })
		expect(banned).toEqual([])
		expect(signals[0].data).toMatchObject({ type: 'admin_remove', onlyIfStarted: true })
		expect(nk.notifications[0].persistent).toBe(false)
	})
	it('only records a chat ban', () => {
		const { nk, banned, signals } = world()
		applyBan(nk as any, fakeLogger, U, 'chat', { banId: 'c', expiresAt: null, reason: '' })
		expect([banned, signals]).toEqual([[], []])
		expect(readBans(nk as any, U).chat?.banId).toBe('c')
	})
})

describe('liftBan', () => {
	it('unbans the account once its account ban goes', () => {
		const { nk, banned } = world()
		applyBan(nk as any, fakeLogger, U, 'account', { banId: 'b1', expiresAt: null, reason: '' })
		applyBan(nk as any, fakeLogger, U, 'chat', { banId: 'c1', expiresAt: null, reason: '' })
		liftBan(nk as any, fakeLogger, U, 'c1')
		expect(banned).toEqual([U])
		liftBan(nk as any, fakeLogger, U, 'b1')
		expect(banned).toEqual([])
		expect(indexKeys(nk)).toEqual([])
		expect(readBans(nk as any, U)).toEqual({})
	})
})

describe('checkLoginBan', () => {
	it('refuses logins while the ban lasts, then lifts it', () => {
		const { nk, banned } = world()
		applyBan(nk as any, fakeLogger, U, 'account', { banId: 'b1', expiresAt: 1000, reason: 'x' })
		expect(() => checkLoginBan(nk as any, fakeLogger, 'device:dev1', 999)).toThrow(/^Account banned until/)
		checkLoginBan(nk as any, fakeLogger, 'custom:765', 1000)
		expect(banned).toEqual([])
		expect(indexKeys(nk)).toEqual([])
		expect(readBans(nk as any, U)).toEqual({})
	})
	it('drops the index entry of a deleted account when its ban has run out', () => {
		// After deletion the entry names the anonymous id, which has no account.
		const R = 'anon-1'
		const unbanned: string[] = []
		const nk = fakeNk({
			accountGetId: () => {
				throw new Error('account not found')
			},
			usersUnbanId: (ids: string[]) => unbanned.push(...ids),
		})
		nk.storageWrite([
			{ collection: BAN_INDEX_COLLECTION, key: 'custom:steamhash:abc', userId: SYSTEM_USER_ID, value: { userId: R, ban: { banId: 'b1', expiresAt: 1000, reason: '' } } },
		])
		expect(() => checkLoginBan(nk as any, fakeLogger, 'custom:steamhash:abc', 999)).toThrow(/^Account banned until/)
		expect(() => checkLoginBan(nk as any, fakeLogger, 'custom:steamhash:abc', 1000)).not.toThrow()
		expect(indexKeys(nk)).toEqual([])
		expect(unbanned).toEqual([])
	})
	it('lets unindexed logins through', () => {
		expect(() => checkLoginBan(fakeNk() as any, fakeLogger, 'custom:1', 0)).not.toThrow()
	})
})

describe('purgeDeletedBanIndex', () => {
	const entry = (userId: string, expiresAt: number | null) => ({ userId, ban: { banId: 'b-' + userId, expiresAt, reason: '' } })
	it('deletes the entries of deleted accounts whose ban has run out, and nothing else', () => {
		const LIVE = 'live'
		const nk = fakeNk({
			accountGetId: (id: string) => {
				if (id !== LIVE) throw new Error('account not found')
				return { user: { id }, customId: 'steamhash:live', devices: [] }
			},
		})
		const put = (key: string, value: unknown) =>
			nk.storageWrite([{ collection: BAN_INDEX_COLLECTION, key, userId: SYSTEM_USER_ID, value }])
		put('custom:steamhash:gone-expired', entry('anon-1', 1000))
		put('device:devicehash:gone-expired', entry('anon-1', 1000))
		put('custom:steamhash:gone-running', entry('anon-2', 5000))
		put('custom:steamhash:gone-permanent', entry('anon-3', null))
		put('custom:steamhash:live', entry(LIVE, 1000))
		expect(purgeDeletedBanIndex(nk as any, 2000, 100)).toEqual({ deleted: 2, more: false })
		expect(indexKeys(nk)).toEqual([
			`${BAN_INDEX_COLLECTION}/${SYSTEM_USER_ID}/custom:steamhash:gone-permanent`,
			`${BAN_INDEX_COLLECTION}/${SYSTEM_USER_ID}/custom:steamhash:gone-running`,
			`${BAN_INDEX_COLLECTION}/${SYSTEM_USER_ID}/custom:steamhash:live`,
		])
	})
	it('stops after max entries and says there are more', () => {
		const nk = fakeNk({ accountGetId: () => { throw new Error('account not found') } })
		for (const key of ['a', 'b', 'c'])
			nk.storageWrite([{ collection: BAN_INDEX_COLLECTION, key, userId: SYSTEM_USER_ID, value: entry('anon-' + key, 1) }])
		expect(purgeDeletedBanIndex(nk as any, 2, 2)).toEqual({ deleted: 2, more: true })
		expect(purgeDeletedBanIndex(nk as any, 2, 2)).toEqual({ deleted: 1, more: false })
	})
})
