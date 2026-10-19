import { describe, expect, it } from 'vitest'
import {
	parseExpiresAt,
	rpcAdminBanApply,
	rpcAdminBanLift,
	rpcAdminConfigSet,
	rpcAdminLobbyKick,
	rpcAdminNotify,
	rpcAdminPing,
} from './admin'
import { DEFAULT_CONFIG, mergeConfig, readConfig } from './config'
import { NotifyCode } from './notify'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from './testing/fake_nk'

const USER = '11111111-1111-1111-1111-111111111111'
const call = (fn: any, nk: any, body: object, ctx = serverCtx()) =>
	JSON.parse(fn(ctx, fakeLogger, nk, JSON.stringify(body)))

describe('server config', () => {
	it('defaults keep everything allowed until the API pushes', () => {
		expect(readConfig(fakeNk() as never)).toEqual(DEFAULT_CONFIG)
	})

	it('merge applies valid fields only', () => {
		const next = mergeConfig(DEFAULT_CONFIG, { tosVersion: 3, chatEnabled: false, rankedEnabled: 'no', bogus: 1, tosVersion2: 9 })
		expect(next).toEqual({ ...DEFAULT_CONFIG, tosVersion: 3, chatEnabled: false })
		expect(DEFAULT_CONFIG.groupQueueEnabled).toBe(true)
		expect(mergeConfig(DEFAULT_CONFIG, { groupQueueEnabled: false }).groupQueueEnabled).toBe(false)
		expect(mergeConfig(DEFAULT_CONFIG, { groupQueueEnabled: 'off' }).groupQueueEnabled).toBe(true)
		expect(mergeConfig(DEFAULT_CONFIG, { tosVersion: -1 }).tosVersion).toBe(1)
		expect(mergeConfig(DEFAULT_CONFIG, { tosVersion: 1.5 }).tosVersion).toBe(1)
		expect(mergeConfig(DEFAULT_CONFIG, { chatAllowlist: ['gg', 'glhf'] }).chatAllowlist).toEqual(['gg', 'glhf'])
		expect(mergeConfig(DEFAULT_CONFIG, { chatAllowlist: ['gg', 3] }).chatAllowlist).toEqual([])
	})

	it('admin_config_set stores the merged config and returns it', () => {
		const nk = fakeNk()
		expect(call(rpcAdminConfigSet, nk, { tosVersion: 2 }).tosVersion).toBe(2)
		const after = call(rpcAdminConfigSet, nk, { lobbyCreationEnabled: false })
		expect(after).toEqual({ ...DEFAULT_CONFIG, tosVersion: 2, lobbyCreationEnabled: false })
		expect(readConfig(nk as never)).toEqual(after)
	})
})

describe('admin RPCs', () => {
	it('refuse player sessions', () => {
		const nk = fakeNk()
		for (const fn of [rpcAdminConfigSet, rpcAdminNotify, rpcAdminPing])
			expect(() => call(fn, nk, {}, playerCtx(USER))).toThrow()
	})

	it('admin_notify sends a known code and refuses unknown ones', () => {
		const nk = fakeNk()
		call(rpcAdminNotify, nk, { userId: USER, code: NotifyCode.BANNED, subject: 'banned', content: { reason: 'x' }, persistent: true })
		expect(nk.notifications).toEqual([
			{ userId: USER, subject: 'banned', content: { reason: 'x' }, code: NotifyCode.BANNED, persistent: true },
		])
		expect(() => call(rpcAdminNotify, nk, { userId: USER, code: 1 })).toThrow()
		expect(() => call(rpcAdminNotify, nk, { userId: 'nope', code: NotifyCode.BANNED })).toThrow()
	})

	it('admin_ping reports whether the API answered, sending the internal key', () => {
		const nk = fakeNk()
		expect(call(rpcAdminPing, nk, {})).toEqual({ ok: true, express: false })
		const env = { EXPRESS_INTERNAL_URL: 'http://nginx:8788/', EXPRESS_INTERNAL_KEY: 'k' }
		expect(call(rpcAdminPing, nk, {}, serverCtx(env))).toEqual({ ok: true, express: true })
		expect(nk.http[0].url).toBe('http://nginx:8788/internal/nakama/ping')
		expect(nk.http[0].headers['X-BMP-Internal-Key']).toBe('k')
		const down = fakeNk({ httpRequest: () => { throw new Error('refused') } })
		expect(call(rpcAdminPing, down, {}, serverCtx(env))).toEqual({ ok: true, express: false })
	})
})

const U = '11111111-1111-4111-8111-111111111111'
const nkWithAccount = (extra = {}) =>
	fakeNk({
		accountGetId: (id: string) => {
			if (id !== U) throw new Error('not found')
			return { user: { id: U }, customId: '765' }
		},
		usersBanId: () => undefined,
		usersUnbanId: () => undefined,
		matchSignal: () => '',
		...extra,
	})

describe('admin ban RPCs', () => {
	it('are server only', () => {
		expect(() => rpcAdminBanApply(playerCtx(U), fakeLogger, nkWithAccount() as any, '{}')).toThrow()
		expect(() => rpcAdminBanLift(playerCtx(U), fakeLogger, nkWithAccount() as any, '{}')).toThrow()
	})
	it('apply and lift a ban', () => {
		const nk = nkWithAccount()
		const body = { userId: U, type: 'chat', banId: 'b1', expiresAt: '2030-01-01T00:00:00Z', reason: 'r' }
		const out = JSON.parse(rpcAdminBanApply(serverCtx(), fakeLogger, nk as any, JSON.stringify(body)))
		expect(out.bans.chat).toEqual({ banId: 'b1', expiresAt: Date.parse('2030-01-01T00:00:00Z'), reason: 'r' })
		const lifted = JSON.parse(rpcAdminBanLift(serverCtx(), fakeLogger, nk as any, JSON.stringify({ userId: U, banId: 'b1' })))
		expect(lifted.bans).toEqual({})
	})
	it('refuse unknown accounts and bad input', () => {
		const nk = nkWithAccount()
		const call = (body: object) => () => rpcAdminBanApply(serverCtx(), fakeLogger, nk as any, JSON.stringify(body))
		expect(call({ userId: '22222222-2222-4222-8222-222222222222', type: 'chat', banId: 'b' })).toThrow()
		expect(call({ userId: U, type: 'mute', banId: 'b' })).toThrow(/type/)
		expect(call({ userId: U, type: 'chat' })).toThrow(/banId/)
		expect(call({ userId: U, type: 'chat', banId: 'b', expiresAt: 'soon' })).toThrow(/expiresAt/)
	})
})

describe('parseExpiresAt', () => {
	it('reads ms, ISO times and null', () => {
		expect(parseExpiresAt(5)).toBe(5)
		expect(parseExpiresAt(null)).toBeNull()
		expect(parseExpiresAt(undefined)).toBeNull()
		expect(parseExpiresAt('1970-01-01T00:00:01Z')).toBe(1000)
		expect(parseExpiresAt('x')).toBeUndefined()
	})
})

describe('admin_lobby_kick', () => {
	it('reports a player who is not seated', () => {
		const nk = nkWithAccount({ matchSignal: () => 'not_member', matchGet: () => ({ matchId: 'm1' }) })
		nk.storageWrite([{ collection: 'lobby_codes', key: 'ABC123', userId: '00000000-0000-0000-0000-000000000000', value: { matchId: 'm1', modId: 'M' } }])
		expect(() =>
			rpcAdminLobbyKick(serverCtx(), fakeLogger, nk as any, JSON.stringify({ code: 'abc123', userId: U })),
		).toThrow(/not in this lobby/)
	})
})
