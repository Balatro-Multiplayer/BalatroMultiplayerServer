import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { deleteNakamaAccount, editNakamaProfile, linkNakamaDiscord } from '../../infrastructure/nakama/profile-sync.js'

const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'
const ANON = '99999999-9999-4999-8999-999999999999'

describe('website account changes reaching Nakama', () => {
	const fetchMock = vi.fn()
	const rpcCall = (i = 0) => {
		const [url, init] = fetchMock.mock.calls[i]
		return { rpc: new URL(url).pathname.split('/').pop(), body: JSON.parse(init.body) }
	}
	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock)
		fetchMock.mockReset()
		fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }))
		env.NAKAMA_URL = 'http://nakama:7350'
		env.NAKAMA_HTTP_KEY = 'hk'
		vi.mocked(playerGateway.findPlayerById).mockResolvedValue({ nakamaUserId: NAKAMA_ID } as any)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		env.NAKAMA_URL = ''
		env.NAKAMA_HTTP_KEY = ''
		vi.mocked(playerGateway.findPlayerById).mockResolvedValue(null)
	})

	it('edits the profile of the player\'s Nakama account', async () => {
		expect(await editNakamaProfile('p1', { privileges: ['tester'] })).toBe(true)
		expect(rpcCall()).toEqual({ rpc: 'admin_profile_set', body: { userId: NAKAMA_ID, privileges: ['tester'] } })
		await editNakamaProfile('p1', { discord: null })
		expect(rpcCall(1).body).toEqual({ userId: NAKAMA_ID, discord: null })
	})

	it('links Discord and deletes the account', async () => {
		await linkNakamaDiscord('p1', 'hash', 'ally')
		expect(rpcCall()).toEqual({
			rpc: 'admin_discord_set',
			body: { userId: NAKAMA_ID, discordIdHash: 'hash', discordUsername: 'ally' },
		})
		expect(await deleteNakamaAccount('p1', ANON)).toEqual({ ok: true, value: 'deleted' })
		expect(rpcCall(1)).toEqual({ rpc: 'admin_account_delete', body: { userId: NAKAMA_ID, anonymousId: ANON } })
	})

	it('skips players without a Nakama account, and reports a failed call', async () => {
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce({ nakamaUserId: null } as any)
		expect(await editNakamaProfile('p1', { useDiscordName: true })).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
		fetchMock.mockResolvedValueOnce(new Response('{"code":5,"message":"No such user"}', { status: 404 }))
		expect(await deleteNakamaAccount('p1', ANON)).toEqual({ ok: true, value: 'no_account' })
		fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }))
		expect(await deleteNakamaAccount('p1', ANON)).toEqual({ ok: false, error: 'unavailable' })
	})
})
