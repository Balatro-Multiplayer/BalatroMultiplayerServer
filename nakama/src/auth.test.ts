import { describe, expect, it } from 'vitest'
import { beforeAuthenticateDevice } from './auth'
import { fakeLogger, fakeNk, serverCtx } from './testing/fake_nk'

const STEAM_ID = '76561198000000001'

function deviceLogin(
	env: { [key: string]: string },
	request: nkruntime.AuthenticateDeviceRequest,
) {
	return beforeAuthenticateDevice(
		serverCtx(env),
		fakeLogger,
		fakeNk() as any,
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
		const request = { account: { id: STEAM_ID }, create: true }
		expect(deviceLogin({ BMP_SERVER_KIND: 'community' }, request)).toEqual(
			request,
		)
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
		expect(first?.account?.id).toBe(STEAM_ID)
		expect(second?.account?.id).toBe(STEAM_ID)
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
