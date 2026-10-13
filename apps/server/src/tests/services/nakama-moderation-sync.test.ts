import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import {
	banInNakama,
	closeNakamaLobby,
	kickFromNakamaLobby,
	liftBanInNakama,
	listNakamaLobbies,
} from '../../infrastructure/nakama/moderation-sync.js'

const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'
const ban = {
	id: 'ban-1',
	playerId: 'p1',
	banType: 'account' as const,
	expiresAt: new Date(5000),
	issuedBy: 'admin:x',
	issuedAt: new Date(0),
	reason: 'cheating',
	liftedAt: null,
	liftedBy: null,
}

describe('moderation reaching Nakama', () => {
	const fetchMock = vi.fn()
	const rpcCall = (i = 0) => {
		const [url, init] = fetchMock.mock.calls[i]
		return { rpc: new URL(url).pathname.split('/').pop(), body: JSON.parse(init.body) }
	}
	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock)
		fetchMock.mockReset()
		fetchMock.mockResolvedValue(new Response('{"bans":{}}', { status: 200 }))
		env.NAKAMA_URL = 'http://nakama:7350'
		env.NAKAMA_HTTP_KEY = 'hk'
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		env.NAKAMA_URL = ''
		env.NAKAMA_HTTP_KEY = ''
	})

	it('applies a ban to the player\'s Nakama account', async () => {
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce({ nakamaUserId: NAKAMA_ID } as any)
		expect(await banInNakama(ban)).toBe(true)
		expect(rpcCall()).toEqual({
			rpc: 'admin_ban_apply',
			body: { userId: NAKAMA_ID, type: 'account', banId: 'ban-1', expiresAt: 5000, reason: 'cheating' },
		})
	})

	it('skips players without a Nakama account, and Nakama being off', async () => {
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce({ nakamaUserId: null } as any)
		expect(await banInNakama(ban)).toBe(false)
		env.NAKAMA_URL = ''
		expect(await liftBanInNakama('p1', 'ban-1')).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lifts a ban', async () => {
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce({ nakamaUserId: NAKAMA_ID } as any)
		expect(await liftBanInNakama('p1', 'ban-1')).toBe(true)
		expect(rpcCall()).toEqual({ rpc: 'admin_ban_lift', body: { userId: NAKAMA_ID, banId: 'ban-1' } })
	})

	it('kicks by Nakama id, mapping a Postgres player id when it has one', async () => {
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce({ nakamaUserId: NAKAMA_ID } as any)
		expect(await kickFromNakamaLobby('ABC123', 'p1', 'admin:x')).toBe(true)
		expect(rpcCall().body).toEqual({ code: 'ABC123', userId: NAKAMA_ID, reason: 'admin:x' })
		vi.mocked(playerGateway.findPlayerById).mockResolvedValueOnce(null)
		await kickFromNakamaLobby('ABC123', NAKAMA_ID, 'admin:x')
		expect(rpcCall(1).body.userId).toBe(NAKAMA_ID)
	})

	it('falls back when Nakama has no such lobby', async () => {
		fetchMock.mockResolvedValue(new Response('{"error":"No such lobby"}', { status: 404 }))
		expect(await closeNakamaLobby('NOPE')).toBe(false)
		expect(await listNakamaLobbies()).toEqual([])
	})

	it('lists only coded lobbies', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ lobbies: [{ code: 'ABC123', size: 2 }, { matchId: 'unlabelled' }] }), {
				status: 200,
			}),
		)
		expect((await listNakamaLobbies()).map((l) => l.code)).toEqual(['ABC123'])
	})
})
