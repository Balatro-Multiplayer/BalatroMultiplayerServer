import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { defaultProfile, readProfile, writeProfile } from './profile'
import { discordOwner, rpcAdminDiscordSet, rpcDiscordLinkStart, rpcDiscordUnlink } from './discord'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const HASH = 'a'.repeat(64)
const ENV = { EXPRESS_INTERNAL_URL: 'http://api', EXPRESS_INTERNAL_KEY: 'k' }

function setup(httpBody = '{"url":"https://discord.com/oauth2?state=x"}') {
	const names: string[] = []
	const nk = fakeNk({
		accountGetId: (id: string) => ({ user: { id, username: 'u', displayName: '' }, customId: '' }),
		accountUpdateId: (_id: string, _u: unknown, name: string) => {
			names.push(name)
		},
		httpRequest: (url: string, _m: string, _h: unknown, body: string) => {
			nk.http.push({ url, method: 'post', headers: {}, body })
			return { code: 200, headers: {}, body: httpBody }
		},
	})
	writeProfile(nk as any, ALICE, defaultProfile('Alice'))
	writeProfile(nk as any, BOB, defaultProfile('Bob'))
	return { nk, names }
}

const adminSet = (nk: unknown, body: unknown) =>
	JSON.parse(rpcAdminDiscordSet(serverCtx(), fakeLogger, nk as any, JSON.stringify(body)))

describe('discord_link_start', () => {
	it('asks the API for the authorize URL for this player', () => {
		const { nk } = setup()
		const res = JSON.parse(rpcDiscordLinkStart(playerCtx(ALICE, ENV), fakeLogger, nk as any, '{}'))
		expect(res.url).toMatch(/^https:\/\/discord.com/)
		expect(nk.http[0].url).toBe('http://api/internal/nakama/discord/link-url')
		expect(JSON.parse(nk.http[0].body)).toEqual({ nakamaUserId: ALICE })
	})
	it('is unavailable without the API', () => {
		const { nk } = setup()
		expect(() => rpcDiscordLinkStart(playerCtx(ALICE), fakeLogger, nk as any, '{}')).toThrow(
			expect.objectContaining({ code: 14 }),
		)
	})
})

describe('admin_discord_set', () => {
	it('links Discord and tells the player', () => {
		const { nk } = setup()
		const res = adminSet(nk, { userId: ALICE, discordIdHash: HASH, discordUsername: 'alice' })
		expect(res.player).toMatchObject({ discordLinked: true, discordUsername: 'alice' })
		expect(readProfile(nk as any, ALICE)?.profile.discordIdHash).toBe(HASH)
		expect(discordOwner(nk as any, HASH)).toBe(ALICE)
		// Linking also earns Scholar (achievements are on by default).
		expect(nk.notifications.map((n) => n.code)).toEqual([NotifyCode.ACCOUNT_UPDATED, NotifyCode.AVATAR_UNLOCKED])
	})
	it('refuses a Discord account linked to another player', () => {
		const { nk } = setup()
		adminSet(nk, { userId: ALICE, discordIdHash: HASH })
		expect(() => adminSet(nk, { userId: BOB, discordIdHash: HASH })).toThrow(expect.objectContaining({ code: 6 }))
		expect(readProfile(nk as any, BOB)?.profile.discordIdHash).toBeNull()
		// Relinking the same account is fine.
		expect(adminSet(nk, { userId: ALICE, discordIdHash: HASH }).player.discordLinked).toBe(true)
	})
	it('frees the old Discord account when relinking another', () => {
		const { nk } = setup()
		adminSet(nk, { userId: ALICE, discordIdHash: HASH })
		adminSet(nk, { userId: ALICE, discordIdHash: 'b'.repeat(64) })
		expect(discordOwner(nk as any, HASH)).toBeNull()
		expect(adminSet(nk, { userId: BOB, discordIdHash: HASH }).player.discordLinked).toBe(true)
	})
	it('is server only and checks its input', () => {
		const { nk } = setup()
		expect(() => rpcAdminDiscordSet(playerCtx(ALICE), fakeLogger, nk as any, JSON.stringify({ userId: ALICE, discordIdHash: HASH }))).toThrow(
			expect.objectContaining({ code: 7 }),
		)
		expect(() => adminSet(nk, { userId: 'x', discordIdHash: HASH })).toThrow(expect.objectContaining({ code: 3 }))
		expect(() => adminSet(nk, { userId: ALICE, discordIdHash: 'no/slashes' })).toThrow(expect.objectContaining({ code: 3 }))
	})
})

describe('discord_unlink', () => {
	it('drops the link, goes back to the Steam name and tells the API', () => {
		const { nk, names } = setup('{}')
		adminSet(nk, { userId: ALICE, discordIdHash: HASH, discordUsername: 'alice' })
		writeProfile(nk as any, ALICE, { ...readProfile(nk as any, ALICE)!.profile, useDiscordName: true })
		const res = JSON.parse(rpcDiscordUnlink(playerCtx(ALICE, ENV), fakeLogger, nk as any, '{}'))
		expect(res.player).toMatchObject({ discordLinked: false, useDiscordName: false, displayName: 'Alice' })
		expect(discordOwner(nk as any, HASH)).toBeNull()
		expect(names[names.length - 1]).toBe('Alice')
		expect(nk.http.map((h) => h.url)).toEqual(['http://api/internal/nakama/discord/unlinked'])
	})
})
