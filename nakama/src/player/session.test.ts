import { describe, expect, it } from 'vitest'
import { writeConfig, DEFAULT_CONFIG } from '../config'
import { emptyProgress } from '../achievements/progress'
import { readProgress, writeProgress } from '../achievements/storage'
import { readBans } from '../moderation/bans'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { readProfile } from './profile'
import { rpcSessionInit, rpcTosAccept, withResolvedMutes } from './session'
import { defaultProfile } from './profile'

const USER = '11111111-1111-4111-8111-111111111111'
const ENV = { EXPRESS_INTERNAL_URL: 'http://api', EXPRESS_INTERNAL_KEY: 'k' }

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
	tosAcceptedVersion: 3,
	chatEnabled: true,
	chatBlocked: false,
	mutedUserIds: ['22222222-2222-4222-8222-222222222222'],
	unresolvedMutedPlayerIds: ['legacy-9'],
	bans: [{ type: 'chat', banId: 'b1', expiresAt: null, reason: 'spam' }],
}

describe('session_init', () => {
	it('syncs a Steam account from the API once, with bans and mutes', () => {
		const acc = account('steam:765')
		let calls = 0
		const nk = fakeNk({
			...acc,
			httpRequest: (url: string) => {
				calls++
				expect(url).toBe('http://api/internal/nakama/player-sync')
				return { code: 200, headers: {}, body: JSON.stringify(SYNC) }
			},
		})
		writeConfig(nk as any, { ...DEFAULT_CONFIG, tosVersion: 3 })
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
		const nk = fakeNk({ ...account('steam:765'), httpRequest: () => ({ code: 502, headers: {}, body: '{}' }) })
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

	it('accepts the ToS with chat eligibility', () => {
		const nk = fakeNk(account(''))
		writeConfig(nk as any, { ...DEFAULT_CONFIG, tosVersion: 4 })
		const res = JSON.parse(rpcTosAccept(playerCtx(USER), fakeLogger, nk as any, JSON.stringify({ chatEligible: false })))
		expect(res.tosRequired).toBe(false)
		expect(res.player.chatBlocked).toBe(true)
		expect(readProfile(nk as any, USER)!.profile.tosAcceptedVersion).toBe(4)
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

describe('session_init avatars', () => {
	function syncing(sync: object) {
		return fakeNk({
			...account('steam:765'),
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
