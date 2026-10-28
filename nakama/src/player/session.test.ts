import { describe, expect, it, vi } from 'vitest'
import { NOTICE_VERSION } from '../../../packages/types/src/notice'
import { writeConfig, DEFAULT_CONFIG } from '../config'
import { emptyProgress } from '../achievements/progress'
import { readProgress, writeProgress } from '../achievements/storage'
import { readBans } from '../moderation/bans'
import { NotifyCode } from '../notify'
import { readModReport, writeModReport } from '../standing/storage'
import { rpcAdminMirrorPull } from '../admin'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { readProfile, writeProfile } from './profile'
import { rpcSessionInit, rpcTosAccept, withResolvedMutes } from './session'
import { defaultProfile } from './profile'

const USER = '11111111-1111-4111-8111-111111111111'
const ENV = { EXPRESS_INTERNAL_URL: 'http://api', EXPRESS_INTERNAL_KEY: 'k' }
const STEAM_ID_HASH = 'dcd52e52066edc9e05b6b85944a5d20bbb703e11de4b075c7cab8e4810b8f72d'
const STEAM_ACCOUNT = `steamhash:${STEAM_ID_HASH}`

function account(customId: string) {
	const state = { displayName: '' }
	return {
		state,
		accountGetId: () => ({ user: { id: USER, username: 'u', displayName: state.displayName }, customId }),
		accountUpdateId: (_id: string, _u: unknown, name: string) => {
			state.displayName = name
		},
	}
}

const SYNC = {
	playerId: 'legacy-1',
	steamName: 'Alice',
	useDiscordName: false,
	preferredJoker: 'j_mime',
	discordIdHash: null,
	discordUsername: null,
	privileges: ['bean'],
	tosAcceptedVersion: NOTICE_VERSION,
	chatEnabled: true,
	chatBlocked: false,
	mutedUserIds: ['22222222-2222-4222-8222-222222222222'],
	unresolvedMutedPlayerIds: ['legacy-9'],
	bans: [{ type: 'chat', banId: 'b1', expiresAt: null, reason: 'spam' }],
}

describe('session_init', () => {
	it('syncs a Steam account from the API once, with bans and mutes', () => {
		const acc = account(STEAM_ACCOUNT)
		let calls = 0
		const nk = fakeNk({
			...acc,
			httpRequest: (url: string, _method: string, _headers: unknown, body: string) => {
				calls++
				expect(url).toBe('http://api/internal/nakama/player-sync')
				expect(JSON.parse(body)).toEqual({ steamIdHash: STEAM_ID_HASH, nakamaUserId: USER, steamName: 'Alice' })
				return { code: 200, headers: {}, body: JSON.stringify(SYNC) }
			},
		})
				const res = JSON.parse(rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, JSON.stringify({ steamName: 'Alice' })))
		expect(res.tosRequired).toBe(false)
		// j_mime needs the staff privilege, which the sync didn't bring: reset.
		expect(res.player).toMatchObject({ id: USER, displayName: 'Alice', preferredJoker: 'j_joker', chatEnabled: true })
		expect(res.player.privileges).toEqual({ jokers: ['j_turtle_bean'] })
		expect(res.player.mutedPlayerIds).toEqual(SYNC.mutedUserIds)
		expect(readBans(nk as any, USER).chat).toEqual({ banId: 'b1', expiresAt: null, reason: 'spam' })
		expect(acc.state.displayName).toBe('Alice')

		// Synced: the next login only tries to resolve the leftover mute.
		nk.httpRequest = (url: string) => {
			calls++
			expect(url).toBe('http://api/internal/nakama/resolve-players')
			return { code: 200, headers: {}, body: JSON.stringify({ resolved: {} }) }
		}
		rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, '{}')
		expect(calls).toBe(2)
	})

	it('still logs in when the sync fails, and retries next time', () => {
		const nk = fakeNk({ ...account(STEAM_ACCOUNT), httpRequest: () => ({ code: 502, headers: {}, body: '{}' }) })
		const res = JSON.parse(rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, JSON.stringify({ steamName: 'Bob' })))
		expect(res.player.displayName).toBe('Bob')
		expect(res.tosRequired).toBe(true)
		expect(readProfile(nk as any, USER)!.profile.synced).toBe(false)
	})

	it('needs no sync for a device (dev) account', () => {
		const nk = fakeNk(account(''))
		rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, '[]')
		expect(nk.http).toHaveLength(0)
		expect(readProfile(nk as any, USER)!.profile.synced).toBe(true)
	})

	it('accepts the Notice with chat eligibility, storing its version and the time', () => {
		vi.useFakeTimers({ now: 1_790_000_000_000 })
		try {
			const nk = fakeNk({ ...account(''), uuidv4: () => 'u1' })
			const res = JSON.parse(rpcTosAccept(playerCtx(USER), fakeLogger, nk as any, JSON.stringify({ chatEligible: false })))
			expect(res.tosRequired).toBe(false)
			expect(res.player.chatBlocked).toBe(true)
			const { profile } = readProfile(nk as any, USER)!
			expect(profile.tosAcceptedVersion).toBe(NOTICE_VERSION)
			expect(profile.noticeAcceptedAt).toBe(1_790_000_000_000)
			const pulled = JSON.parse(rpcAdminMirrorPull(serverCtx(), fakeLogger, nk as any, '{}'))
			expect(pulled.entries).toEqual([
				{ key: expect.any(String), kind: 'notice', at: 1_790_000_000_000, userId: USER, version: NOTICE_VERSION },
			])
			expect(pulled.players[USER]).toBeDefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it('asks again when the Notice version is newer than the accepted one', () => {
		const nk = fakeNk(account(''))
		writeProfile(nk as any, USER, { ...defaultProfile('u'), synced: true, tosAcceptedVersion: NOTICE_VERSION - 1 })
		const res = JSON.parse(rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, '{}'))
		expect(res.tosRequired).toBe(true)
	})
})

describe('the Notice by server kind', () => {
	const COMMUNITY = { ...ENV, BMP_SERVER_KIND: 'community' }
	const login = (nk: unknown, env: { [key: string]: string }) =>
		JSON.parse(rpcSessionInit(playerCtx(USER, env), fakeLogger, nk as any, '{}'))

	it('asks a new player on a Community server only the age', () => {
		const res = login(fakeNk(account('')), COMMUNITY)
		expect(res.tosRequired).toBe(false)
		expect(res.ageRequired).toBe(true)
	})

	it('takes the age answer on a Community server without recording a Notice acceptance', () => {
		const nk = fakeNk({ ...account(''), uuidv4: () => 'u1' })
		login(nk, COMMUNITY)
		const res = JSON.parse(rpcTosAccept(playerCtx(USER, COMMUNITY), fakeLogger, nk as any, JSON.stringify({ chatEligible: false })))
		expect(res).toMatchObject({ tosRequired: false, ageRequired: false })
		expect(res.player).toMatchObject({ chatEnabled: false, chatBlocked: true })
		expect(readProfile(nk as any, USER)!.profile).toMatchObject({ tosAcceptedVersion: 0, noticeAcceptedAt: null })
		expect(JSON.parse(rpcAdminMirrorPull(serverCtx(), fakeLogger, nk as any, '{}')).entries).toEqual([])
		expect(login(nk, COMMUNITY)).toMatchObject({ tosRequired: false, ageRequired: false })
	})

	it('asks the age once: a player who answered it on the Official server is not asked again', () => {
		const nk = fakeNk({ ...account(''), uuidv4: () => 'u1' })
		rpcTosAccept(playerCtx(USER), fakeLogger, nk as any, JSON.stringify({ chatEligible: true }))
		expect(login(nk, ENV)).toMatchObject({ tosRequired: false, ageRequired: false })
		expect(login(nk, COMMUNITY)).toMatchObject({ tosRequired: false, ageRequired: false })
	})

	it('counts an older profile with an accepted Notice as answered', () => {
		const nk = fakeNk(account(''))
		const { ageAnswered: _, ...older } = { ...defaultProfile('u'), synced: true, tosAcceptedVersion: NOTICE_VERSION }
		writeProfile(nk as any, USER, older as any)
		expect(login(nk, ENV)).toMatchObject({ tosRequired: false, ageRequired: false })
	})
})

describe('withResolvedMutes', () => {
	it('moves resolved legacy ids into mutedUserIds', () => {
		const p = { ...defaultProfile('A'), unresolvedMutedPlayerIds: ['x', 'y'] }
		const next = withResolvedMutes(p, { x: 'nx' })
		expect(next.mutedUserIds).toEqual(['nx'])
		expect(next.unresolvedMutedPlayerIds).toEqual(['y'])
	})
})

describe('session_init mod report', () => {
	it("clears the last session's report, so the new session starts unreported", () => {
		const nk = fakeNk({ ...account(''), httpRequest: () => ({ code: 502, headers: {}, body: '{}' }) })
		writeModReport(nk as any, USER, { mods: ['MultiplayerAPI-0.1.2'], reportedAt: 1 })
		rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, '{}')
		expect(readModReport(nk as any, USER)).toBeNull()
	})
})

describe('session_init avatars', () => {
	function syncing(sync: object) {
		return fakeNk({
			...account(STEAM_ACCOUNT),
			httpRequest: () => ({ code: 200, headers: {}, body: JSON.stringify({ ...SYNC, ...sync }) }),
		})
	}
	const login = (nk: unknown) =>
		JSON.parse(rpcSessionInit(playerCtx(USER, ENV), fakeLogger, nk as any, JSON.stringify({ steamName: 'Alice' })))

	it('keeps a synced joker the synced privileges or earned avatars allow', () => {
		expect(login(syncing({ preferredJoker: 'j_turtle_bean' })).player.preferredJoker).toBe('j_turtle_bean')
		const nk = syncing({ preferredJoker: 'j_baron' })
		writeProgress(nk as any, USER, { ...emptyProgress(), unlocked: ['j_baron'] })
		expect(login(nk).player.preferredJoker).toBe('j_baron')
		expect(login(syncing({ preferredJoker: 'j_nope' })).player.preferredJoker).toBe('j_joker')
	})

	it('earns Scholar for a linked Discord once achievements are on', () => {
		const linked = { discordIdHash: 'h'.repeat(64), discordUsername: 'ally' }
		const off = syncing(linked)
		writeConfig(off as any, { ...DEFAULT_CONFIG, achievementsEnabled: false })
		login(off)
		expect(off.notifications.filter((n) => n.code === NotifyCode.AVATAR_UNLOCKED)).toEqual([])

		const on = syncing(linked)
		writeConfig(on as any, { ...DEFAULT_CONFIG, achievementsEnabled: true })
		login(on)
		login(on)
		const pushed = on.notifications.filter((n) => n.code === NotifyCode.AVATAR_UNLOCKED)
		expect(pushed).toHaveLength(1)
		expect(pushed[0]).toMatchObject({ persistent: true, content: { avatarIds: ['j_scholar'], runId: null } })
		expect(readProgress(on as any, USER)!.progress.milestones).toEqual(['discordLinked'])
	})
})
