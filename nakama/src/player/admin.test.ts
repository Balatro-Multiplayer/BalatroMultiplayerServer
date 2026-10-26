import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { refuseClientAccountDelete, rpcAdminAccountDelete, rpcAdminProfileSet } from './admin'
import { discordOwner, rpcAdminDiscordSet } from './discord'
import { emptyProgress } from '../achievements/progress'
import { writeProgress } from '../achievements/storage'
import { defaultProfile, readProfile, writeProfile } from './profile'

const ALICE = '11111111-1111-4111-8111-111111111111'
const HASH = 'a'.repeat(64)

function setup() {
	const deleted: string[] = []
	const nk = fakeNk({
		accountGetId: (id: string) => {
			if (deleted.indexOf(id) !== -1 || id !== ALICE) throw new Error('not found')
			return { user: { id, username: 'u', displayName: 'Alice' }, customId: '' }
		},
		accountUpdateId: () => undefined,
		sessionLogout: (id: string, token: string, refresh: string) => deleted.push(`logout:${id}:${token}${refresh}`),
		accountDeleteId: (id: string) => deleted.push(id),
	})
	writeProfile(nk as any, ALICE, defaultProfile('Alice'))
	return { nk, deleted }
}

const set = (nk: unknown, body: object) =>
	JSON.parse(rpcAdminProfileSet(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, ...body })))

describe('admin_profile_set', () => {
	it('grants privileges and tells the player at once', () => {
		const { nk } = setup()
		expect(set(nk, { privileges: ['virtualized'] }).player.privileges).toEqual({ jokers: ['j_perkeo'] })
		expect(readProfile(nk as any, ALICE)?.profile.privileges).toEqual(['virtualized'])
		const pushed = nk.notifications.find((n) => n.code === NotifyCode.ACCOUNT_UPDATED)
		expect(pushed?.content.player.privileges).toEqual({ jokers: ['j_perkeo'] })
	})

	it('checks a joker against the privileges it is sent with', () => {
		const { nk } = setup()
		expect(() => set(nk, { preferredJoker: 'j_perkeo' })).toThrow(/Invalid joker/)
		expect(set(nk, { privileges: ['virtualized'], preferredJoker: 'j_perkeo' }).player.preferredJoker).toBe('j_perkeo')
	})

	it('resets the joker when the privilege behind it is taken away', () => {
		const { nk } = setup()
		set(nk, { privileges: ['virtualized', 'staff'], preferredJoker: 'j_perkeo' })
		expect(set(nk, { privileges: ['staff'] }).player.preferredJoker).toBe('j_joker')
		set(nk, { preferredJoker: 'j_ring_master' })
		expect(set(nk, { privileges: ['staff', 'bean'] }).player.preferredJoker).toBe('j_ring_master')
		expect(set(nk, { privileges: [] }).player.preferredJoker).toBe('j_joker')
	})

	it('keeps an earned joker when privileges change', () => {
		const { nk } = setup()
		writeProgress(nk as any, ALICE, { ...emptyProgress(), unlocked: ['j_ring_master'] })
		set(nk, { privileges: ['staff'], preferredJoker: 'j_ring_master' })
		expect(set(nk, { privileges: [] }).player.preferredJoker).toBe('j_ring_master')
	})

	it('needs a linked Discord for the Discord name, and unlinks it', () => {
		const { nk } = setup()
		expect(() => set(nk, { useDiscordName: true })).toThrow(/not linked/)
		rpcAdminDiscordSet(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, discordIdHash: HASH, discordUsername: 'ally' }))
		expect(set(nk, { useDiscordName: true }).player.displayName).toBe('ally')
		const after = set(nk, { discord: null }).player
		expect(after.displayName).toBe('Alice')
		expect(discordOwner(nk as any, HASH)).toBeNull()
	})

	it('takes a Notice acceptance and an age answer made on the website, so the game does not ask again', () => {
		const { nk } = setup()
		set(nk, { notice: { version: 2, acceptedAt: 1_700_000_000_000 }, chatEligible: false })
		const profile = readProfile(nk as any, ALICE)?.profile
		expect(profile?.tosAcceptedVersion).toBe(2)
		expect(profile?.noticeAcceptedAt).toBe(1_700_000_000_000)
		expect(profile?.ageAnswered).toBe(true)
		expect(profile?.chatEnabled).toBe(false)
		expect(profile?.chatBlocked).toBe(true)
		expect(() => set(nk, { notice: { version: 'two', acceptedAt: 1 } })).toThrow(/notice/)
		expect(() => set(nk, { chatEligible: 'yes' })).toThrow(/chatEligible/)
	})

	it('refuses bad input, unknown players and players', () => {
		const { nk } = setup()
		expect(() => set(nk, { privileges: 'admin' })).toThrow(/privileges/)
		expect(() => set(nk, { discord: { id: 'x' } })).toThrow(/unlink/)
		expect(() => set(nk, { userId: '22222222-2222-4222-8222-222222222222' })).toThrow(/No such user/)
		expect(() => rpcAdminProfileSet(playerCtx(ALICE), fakeLogger, nk as any, JSON.stringify({ userId: ALICE }))).toThrow()
	})
})

describe('admin_account_delete', () => {
	it('ends the sessions, frees the Discord link and deletes the account', () => {
		const { nk, deleted } = setup()
		rpcAdminDiscordSet(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, discordIdHash: HASH }))
		const res = JSON.parse(rpcAdminAccountDelete(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, anonymousId: '99999999-9999-4999-8999-999999999999', keptRunIds: [], keepSteamIdHash: false })))
		expect(res).toEqual({ deleted: true })
		expect(deleted).toEqual([`logout:${ALICE}:`, ALICE])
		expect(discordOwner(nk as any, HASH)).toBeNull()
		expect(() => rpcAdminAccountDelete(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, anonymousId: '99999999-9999-4999-8999-999999999999', keptRunIds: [], keepSteamIdHash: false }))).toThrow(/No such user/)
	})
})

describe('refuseClientAccountDelete', () => {
	it("refuses Nakama's own account delete, so every deletion runs the anonymization", () => {
		const { nk } = setup()
		expect(() => refuseClientAccountDelete(playerCtx(ALICE), fakeLogger, nk as any)).toThrow(
			expect.objectContaining({ code: 7, message: expect.stringMatching(/website/) }),
		)
	})
})
