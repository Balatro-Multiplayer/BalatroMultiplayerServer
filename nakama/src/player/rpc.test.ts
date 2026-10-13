import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { defaultProfile, readProfile, writeProfile } from './profile'
import { rpcMuteSet, rpcProfileSetDisplay, rpcProfileSetJoker, rpcProfileSetMods } from './rpc'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function nkWith(profile = defaultProfile('Alice')) {
	const names: string[] = []
	const nk = fakeNk({
		accountGetId: () => ({ user: { id: USER, username: 'u', displayName: 'Alice' }, customId: '' }),
		accountUpdateId: (_id: string, _u: unknown, name: string) => {
			names.push(name)
		},
	})
	writeProfile(nk as any, USER, profile)
	return { nk, names }
}

function call(fn: Function, nk: unknown, body: unknown) {
	return JSON.parse(fn(playerCtx(USER), fakeLogger, nk, JSON.stringify(body)))
}

describe('profile_set_display', () => {
	it('needs a linked Discord to use its name', () => {
		const { nk } = nkWith()
		expect(() => call(rpcProfileSetDisplay, nk, { useDiscordName: true })).toThrow(/not linked/)
	})

	it('switches the display name and tells the other sessions', () => {
		const { nk, names } = nkWith({ ...defaultProfile('Alice'), discordIdHash: 'h', discordUsername: 'alice#1' })
		const res = call(rpcProfileSetDisplay, nk, { useDiscordName: true })
		expect(res.player).toMatchObject({ displayName: 'alice#1', useDiscordName: true })
		expect(names).toEqual(['alice#1'])
		expect(nk.notifications[0]).toMatchObject({ userId: USER, code: NotifyCode.ACCOUNT_UPDATED })
		expect(nk.notifications[0].content.player.displayName).toBe('alice#1')
	})

	it('wants a boolean', () => {
		const { nk } = nkWith()
		expect(() => call(rpcProfileSetDisplay, nk, { useDiscordName: 'yes' })).toThrow(/useDiscordName/)
	})
})

describe('profile_set_joker', () => {
	it('takes a standard joker', () => {
		const { nk } = nkWith()
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_mime' }).player.preferredJoker).toBe('j_mime')
		expect(readProfile(nk as any, USER)!.profile.preferredJoker).toBe('j_mime')
	})

	it('refuses unknown jokers and privilege jokers without the privilege', () => {
		const { nk } = nkWith()
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_nope' })).toThrow(/Invalid joker/)
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_turtle_bean' })).toThrow(/Invalid joker/)
	})

	it('takes a privilege joker with the privilege', () => {
		const { nk } = nkWith({ ...defaultProfile('Alice'), privileges: ['bean'] })
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_turtle_bean' }).player.preferredJoker).toBe('j_turtle_bean')
	})
})

describe('profile_set_mods', () => {
	it('stores a list of strings, capped', () => {
		const { nk } = nkWith()
		expect(call(rpcProfileSetMods, nk, { mods: ['A-1', 'B-2'] })).toEqual({ mods: ['A-1', 'B-2'] })
		expect(readProfile(nk as any, USER)!.profile.mods).toEqual(['A-1', 'B-2'])
		const many = call(rpcProfileSetMods, nk, { mods: Array.from({ length: 400 }, (_, i) => 'M' + i) })
		expect(many.mods.length).toBe(300)
		expect(() => call(rpcProfileSetMods, nk, { mods: [1] })).toThrow(/mods/)
	})
})

describe('mute_set', () => {
	it('mutes and unmutes, once each', () => {
		const { nk } = nkWith()
		expect(call(rpcMuteSet, nk, { userId: OTHER, muted: true })).toEqual({ mutedPlayerIds: [OTHER] })
		expect(call(rpcMuteSet, nk, { userId: OTHER, muted: true })).toEqual({ mutedPlayerIds: [OTHER] })
		expect(call(rpcMuteSet, nk, { userId: OTHER, muted: false })).toEqual({ mutedPlayerIds: [] })
	})

	it('refuses self and junk ids', () => {
		const { nk } = nkWith()
		expect(() => call(rpcMuteSet, nk, { userId: USER, muted: true })).toThrow(/yourself/)
		expect(() => call(rpcMuteSet, nk, { userId: 'x', muted: true })).toThrow(/userId/)
	})
})
