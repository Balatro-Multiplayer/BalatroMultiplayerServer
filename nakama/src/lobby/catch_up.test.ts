import { describe, expect, it } from 'vitest'
import { CATCH_UP_LIMIT_MS_BY_MOD, catchUpLimitMsFor } from './catch_up'
import { type Lobby, join, joinRejection, newLobby, setCatchingUp, tick, FORFEITED_SEAT } from './state'

const info = (name: string) => ({ displayName: name, preferredJoker: null, mods: null })
const LIMIT = 180_000

function runningLobby(modId: string): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId,
		maxPlayers: 2,
		creatorId: 'a',
		now: 0,
		graceMs: 120_000,
		catchUpLimitMs: catchUpLimitMsFor(modId),
	})
	for (const id of ['a', 'b']) lobby = join(lobby, id, `${id}-s1`, info(id)).lobby
	return { ...lobby, game: { ...lobby.game, started: { runId: 'r1', players: [{ id: 'a' }, { id: 'b' }] } as any } }
}

describe('catchUpLimitMsFor', () => {
	it('gives PvP 3 min and SPDRN none', () => {
		expect(catchUpLimitMsFor('MultiplayerPvP')).toBe(LIMIT)
		expect(CATCH_UP_LIMIT_MS_BY_MOD.MultiplayerSPDRN).toBeUndefined()
		expect(catchUpLimitMsFor('MultiplayerSPDRN')).toBeNull()
		expect(catchUpLimitMsFor('SomeOtherMod')).toBeNull()
	})

	it('lets a test shorten a limit, never add one', () => {
		expect(catchUpLimitMsFor('MultiplayerPvP', 20)).toBe(20_000)
		expect(catchUpLimitMsFor('MultiplayerPvP', 0)).toBe(LIMIT)
		expect(catchUpLimitMsFor('MultiplayerSPDRN', 20)).toBeNull()
	})
})

describe('the catch-up limit in tick', () => {
	it('forfeits a PvP seat that is still catching up at the limit, like a grace forfeit', () => {
		const lobby = setCatchingUp(runningLobby('MultiplayerPvP'), 'b', true, 1000).lobby
		const early = tick(lobby, 1000 + LIMIT - 1)
		expect(early.out).toEqual([])
		const step = tick(lobby, 1000 + LIMIT)
		expect(step.out).toContainEqual({
			kind: 'forfeited',
			userId: 'b',
			runId: 'r1',
			code: 'ABC123',
			at: 1000 + LIMIT,
			lobbyKind: expect.anything(),
		})
		expect(step.lobby.players.map((p) => p.id)).toEqual(['a'])
		expect(joinRejection(step.lobby, 'b', 'MultiplayerPvP')).toBe(FORFEITED_SEAT)
	})

	it('does not forfeit a seat that caught up in time', () => {
		let lobby = setCatchingUp(runningLobby('MultiplayerPvP'), 'b', true, 1000).lobby
		lobby = setCatchingUp(lobby, 'b', false, 60_000).lobby
		expect(tick(lobby, 1000 + 10 * LIMIT).out).toEqual([])
	})

	it('does not forfeit a seat that never said it was catching up', () => {
		expect(tick(runningLobby('MultiplayerPvP'), 10 * LIMIT).out).toEqual([])
	})

	it('has no limit in an SPDRN lobby', () => {
		const lobby = setCatchingUp(runningLobby('MultiplayerSPDRN'), 'b', true, 1000).lobby
		const step = tick(lobby, 1000 + 100 * LIMIT)
		expect(step.out).toEqual([])
		expect(step.lobby.players.map((p) => p.id)).toEqual(['a', 'b'])
	})
})
