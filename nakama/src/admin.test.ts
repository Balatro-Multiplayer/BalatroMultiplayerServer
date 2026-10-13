import { describe, expect, it } from 'vitest'
import { rpcAdminConfigSet, rpcAdminNotify, rpcAdminPing } from './admin'
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
		expect(mergeConfig(DEFAULT_CONFIG, { tosVersion: -1 }).tosVersion).toBe(1)
		expect(mergeConfig(DEFAULT_CONFIG, { tosVersion: 1.5 }).tosVersion).toBe(1)
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
