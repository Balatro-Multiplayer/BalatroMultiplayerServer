import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { NotifyCode } from '../notify'
import { readModReport } from '../standing/storage'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { emptyProgress } from '../achievements/progress'
import { writeProgress } from '../achievements/storage'
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
	it('takes a default joker', () => {
		const { nk } = nkWith()
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_jolly' }).player.preferredJoker).toBe('j_jolly')
		expect(readProfile(nk as any, USER)!.profile.preferredJoker).toBe('j_jolly')
	})

	it('takes an earned joker only once it is earned', () => {
		const { nk } = nkWith()
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_baron' })).toThrow(/Invalid joker/)
		writeProgress(nk as any, USER, { ...emptyProgress(), unlocked: ['j_baron'] })
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_baron' }).player.preferredJoker).toBe('j_baron')
	})

	it('never takes a reserved joker', () => {
		const { nk } = nkWith()
		writeProgress(nk as any, USER, { ...emptyProgress(), unlocked: ['j_blueprint' as any] })
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_blueprint' })).toThrow(/Invalid joker/)
	})

	it('refuses unknown jokers and privilege jokers without the privilege', () => {
		const { nk } = nkWith()
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_nope' })).toThrow(/Invalid joker/)
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_turtle_bean' })).toThrow(/Invalid joker/)
		expect(() => call(rpcProfileSetJoker, nk, { preferredJoker: 'j_mime' })).toThrow(/Invalid joker/)
	})

	it('takes Mime and Showman with the staff privilege', () => {
		const { nk } = nkWith({ ...defaultProfile('Alice'), privileges: ['staff'] })
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_mime' }).player.preferredJoker).toBe('j_mime')
		const res = call(rpcProfileSetJoker, nk, { preferredJoker: 'j_ring_master' })
		expect(res.player.preferredJoker).toBe('j_ring_master')
		expect(res.player.privileges).toEqual({ jokers: ['j_ring_master', 'j_mime'] })
	})

	it('takes a privilege joker with the privilege', () => {
		const { nk } = nkWith({ ...defaultProfile('Alice'), privileges: ['bean'] })
		expect(call(rpcProfileSetJoker, nk, { preferredJoker: 'j_turtle_bean' }).player.preferredJoker).toBe('j_turtle_bean')
	})
})

describe('profile_set_mods', () => {
	it('stores a list of strings, capped', () => {
		const { nk } = nkWith()
		expect(call(rpcProfileSetMods, nk, { mods: ['A-1', 'B-2'] })).toEqual({
			mods: ['A-1', 'B-2'],
			standing: { standing: 'valid', disallowed: [], reason: null, enforced: false },
		})
		expect(readProfile(nk as any, USER)!.profile.mods).toEqual(['A-1', 'B-2'])
		const many = call(rpcProfileSetMods, nk, { mods: Array.from({ length: 400 }, (_, i) => 'M' + i) })
		expect(many.mods.length).toBe(300)
		expect(() => call(rpcProfileSetMods, nk, { mods: [1] })).toThrow(/mods/)
	})

	it("stores this session's report and answers with the standing it gives", () => {
		const { nk } = nkWith()
		writeConfig(nk as any, { ...DEFAULT_CONFIG, queueModsEnforced: true, queueAllowedModIds: ['MultiplayerAPI'] })
		const reply = call(rpcProfileSetMods, nk, { mods: ['Steamodded-1.0.0~BETA-1814a', 'MultiplayerAPI-0.1.2', 'Cryptid-0.5.3'] })
		expect(reply.standing).toEqual({ standing: 'none', disallowed: ['Cryptid'], reason: 'mods_not_allowed', enforced: true })
		expect(readModReport(nk as any, USER)!.mods).toEqual(['Steamodded-1.0.0~BETA-1814a', 'MultiplayerAPI-0.1.2', 'Cryptid-0.5.3'])
		expect(call(rpcProfileSetMods, nk, { mods: ['MultiplayerAPI-0.1.2'] }).standing.standing).toBe('valid')
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
