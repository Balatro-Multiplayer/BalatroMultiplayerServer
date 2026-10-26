import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { beforeAuthenticateCustom, beforeAuthenticateDevice } from './auth'
import { SYSTEM_USER_ID } from './lobby/protocol'
import { fakeLogger, fakeNk, serverCtx } from './testing/fake_nk'

const STEAM_ID = '76561198000000001'
const SALT = 'pepper'
// sha256('76561198000000001' + 'pepper'), worked out once by hand.
const STEAM_ID_HASH = 'dcd52e52066edc9e05b6b85944a5d20bbb703e11de4b075c7cab8e4810b8f72d'
const sha256Hash = (input: string) => createHash('sha256').update(input).digest('hex')

function steamNk(overrides: { [key: string]: unknown } = {}) {
	return fakeNk({
		sha256Hash,
		httpRequest: () => ({
			code: 200,
			headers: {},
			body: JSON.stringify({ response: { params: { result: 'OK', steamid: STEAM_ID } } }),
		}),
		...overrides,
	})
}

function steamLogin(env: { [key: string]: string }, nk = steamNk()) {
	return beforeAuthenticateCustom(serverCtx({ STEAM_WEB_API_KEY: 'key', ...env }), fakeLogger, nk as any, {
		account: { id: 'placeholder', vars: { steam_ticket: 'ab'.repeat(16) } },
		create: true,
	})
}

describe('Steam login', () => {
	it('names the account by the peppered hash of the Steam id, never the raw id', () => {
		const out = steamLogin({ PLAYER_ID_SALT: SALT })
		expect(out?.account?.id).toBe(`steamhash:${STEAM_ID_HASH}`)
		expect(JSON.stringify(out)).not.toContain(STEAM_ID)
	})

	it('is refused when PLAYER_ID_SALT is not set, so no account is named by a bare id', () => {
		expect(() => steamLogin({})).toThrow(/not configured/)
	})
})

// A fake of Nakama's device table (user_device), reached through sqlQuery,
// linkDevice and unlinkDevice as the hook reaches it.
function deviceNk(devices: Map<string, string> = new Map()) {
	return fakeNk({
		sha256Hash,
		devices,
		sqlQuery: (query: string, params: string[]) => {
			expect(query).toMatch(/FROM user_device/)
			const userId = devices.get(params[0])
			return userId ? [{ user_id: userId }] : []
		},
		linkDevice: (userId: string, id: string) => {
			if (devices.has(id)) throw new Error('Device ID already in use.')
			devices.set(id, userId)
		},
		unlinkDevice: (userId: string, id: string) => {
			if (devices.get(id) === userId) devices.delete(id)
		},
	})
}

function deviceLogin(
	env: { [key: string]: string },
	request: nkruntime.AuthenticateDeviceRequest,
	nk = deviceNk(),
) {
	return beforeAuthenticateDevice(
		serverCtx({ PLAYER_ID_SALT: SALT, ...env }),
		fakeLogger,
		nk as any,
		request,
	)
}

describe('Device login', () => {
	it('is refused on the Official server', () => {
		expect(() =>
			deviceLogin({}, { account: { id: STEAM_ID }, create: true }),
		).toThrow(/Device login is disabled/)
	})

	it('is accepted on a Community server with no ALLOW_DEVICE_AUTH set', () => {
		const out = deviceLogin({ BMP_SERVER_KIND: 'community' }, { account: { id: 'bmp-dev-TestPlayer1' }, create: true })
		expect(out?.create).toBe(true)
		expect(out?.account?.id).toMatch(/^devicehash:[0-9a-f]{64}$/)
	})

	it('stores any device id only as its hash, the same on every login', () => {
		// sha256('bmp-dev-TestPlayer1' + 'pepper'), worked out once with node:crypto.
		const TEST_HASH = 'c3deab977d0c924144b4601d980c2315831abc91197bacced5d2030d61ae6719'
		const env = { BMP_SERVER_KIND: 'dev' }
		const first = deviceLogin(env, { account: { id: 'bmp-dev-TestPlayer1' }, create: true, username: 'TestPlayer1' })
		const second = deviceLogin(env, { account: { id: 'bmp-dev-TestPlayer1' }, create: true, username: 'TestPlayer1' })
		expect(first?.account?.id).toBe(`devicehash:${TEST_HASH}`)
		expect(second?.account?.id).toBe(first?.account?.id)
		expect(JSON.stringify(first)).not.toContain('bmp-dev-TestPlayer1')
	})

	it('moves a test account on its raw device id to the hash at its next login, keeping the account', () => {
		const devices = new Map([['bmp-dev-TestPlayer1', 'user-2']])
		const out = deviceLogin({ BMP_SERVER_KIND: 'dev' }, { account: { id: 'bmp-dev-TestPlayer1' }, create: true }, deviceNk(devices))
		expect(out?.account?.id).toMatch(/^devicehash:/)
		expect([...devices.entries()]).toEqual([[out?.account?.id, 'user-2']])
	})

	it('stores a Steam id only as its hash', () => {
		const out = deviceLogin(
			{ BMP_SERVER_KIND: 'community' },
			{ account: { id: STEAM_ID }, create: true },
		)
		expect(out?.account?.id).toBe(`devicehash:${STEAM_ID_HASH}`)
		expect(JSON.stringify(out)).not.toContain(STEAM_ID)
	})

	it('moves an account on the raw Steam id to the hash at its next login, keeping the account', () => {
		const devices = new Map([[STEAM_ID, 'user-1']])
		const out = deviceLogin(
			{ BMP_SERVER_KIND: 'community' },
			{ account: { id: STEAM_ID }, create: true },
			deviceNk(devices),
		)
		expect(out?.account?.id).toBe(`devicehash:${STEAM_ID_HASH}`)
		expect([...devices.entries()]).toEqual([[`devicehash:${STEAM_ID_HASH}`, 'user-1']])
	})

	it('still refuses a banned raw-id account after moving it', () => {
		const devices = new Map([[STEAM_ID, 'user-1']])
		const nk = deviceNk(devices)
		nk.storageWrite([
			{
				collection: 'ban_index',
				key: `device:${STEAM_ID}`,
				userId: SYSTEM_USER_ID,
				value: { userId: 'user-1', ban: { banId: 'b1', reason: 'cheating', expiresAt: null } },
			},
		])
		expect(() =>
			deviceLogin({ BMP_SERVER_KIND: 'community' }, { account: { id: STEAM_ID }, create: true }, nk),
		).toThrow(/cheating/)
		expect([...nk.objects.keys()]).toEqual([`ban_index/${SYSTEM_USER_ID}/device:devicehash:${STEAM_ID_HASH}`])
	})

	it('gives a Steam id the same device id on every login, whatever name it sends', () => {
		const env = { BMP_SERVER_KIND: 'community' }
		const first = deviceLogin(env, {
			account: { id: STEAM_ID },
			create: true,
			username: 'Jimbo',
		})
		const second = deviceLogin(env, {
			account: { id: STEAM_ID },
			create: true,
			username: 'Jimbo Renamed',
		})
		expect(first?.account?.id).toBe(`devicehash:${STEAM_ID_HASH}`)
		expect(second?.account?.id).toBe(`devicehash:${STEAM_ID_HASH}`)
	})

	it('drops the username a Steam-id login sends, so two players with one Steam name both get in', () => {
		const out = deviceLogin(
			{ BMP_SERVER_KIND: 'community' },
			{ account: { id: STEAM_ID }, create: true, username: 'Jimbo' },
		)
		expect(out && 'username' in out).toBe(false)
	})

	it('keeps the username of a test account login on a Dev server', () => {
		const out = deviceLogin(
			{ BMP_SERVER_KIND: 'dev' },
			{
				account: { id: 'bmptest_alice_device' },
				create: true,
				username: 'bmptest_alice',
			},
		)
		expect(out?.username).toBe('bmptest_alice')
	})

	it('is refused on a Dev server that switches it off', () => {
		expect(() =>
			deviceLogin(
				{ BMP_SERVER_KIND: 'dev', ALLOW_DEVICE_AUTH: 'false' },
				{ account: { id: STEAM_ID } },
			),
		).toThrow(/Device login is disabled/)
	})
})
