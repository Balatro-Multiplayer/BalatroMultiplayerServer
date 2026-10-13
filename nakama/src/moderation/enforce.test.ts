import { describe, expect, it } from 'vitest'
import { CURRENT_LOBBY_COLLECTION, CURRENT_LOBBY_KEY, SYSTEM_USER_ID } from '../lobby/protocol'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk } from '../testing/fake_nk'
import { readBans } from './bans'
import { applyBan, BAN_INDEX_COLLECTION, checkLoginBan, liftBan } from './enforce'

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
	it('lets unindexed logins through', () => {
		expect(() => checkLoginBan(fakeNk() as any, fakeLogger, 'custom:1', 0)).not.toThrow()
	})
})
