import { describe, expect, it } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { bindCode, reserveCode } from './codes'
import { rpcLobbyFind } from './rpc'

function nakamaWithLobby() {
	const nk: any = fakeNk({ matchGet: (id: string) => (id === 'm1' ? { matchId: 'm1' } : null) })
	reserveCode(nk, 'ABC123', 'MultiplayerPvP')
	bindCode(nk, 'ABC123', 'm1', 'MultiplayerPvP')
	return nk
}

const find = (nk: any, payload: object) => JSON.parse(rpcLobbyFind(playerCtx('a'), fakeLogger, nk, JSON.stringify(payload)))

describe('lobby_find', () => {
	it('finds any mod lobby when the caller names no mod', () => {
		expect(find(nakamaWithLobby(), { code: 'abc123' })).toEqual({ matchId: 'm1', code: 'ABC123', modId: 'MultiplayerPvP' })
	})

	it('finds the lobby for the mod the caller names', () => {
		expect(find(nakamaWithLobby(), { code: 'ABC123', modId: 'MultiplayerPvP' }).matchId).toBe('m1')
	})

	it("refuses a lobby for another mod than the caller's", () => {
		expect(() => find(nakamaWithLobby(), { code: 'ABC123', modId: 'MultiplayerSPDRN' })).toThrow(
			'Lobby is for a different mod',
		)
	})

	it('refuses a malformed modId', () => {
		expect(() => find(nakamaWithLobby(), { code: 'ABC123', modId: 'bad mod' })).toThrow('Invalid modId')
	})
})
