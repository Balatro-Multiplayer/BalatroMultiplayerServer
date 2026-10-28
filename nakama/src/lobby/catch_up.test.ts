import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { lobbyMatchLoop } from './match'
import { CATCH_UP_LIMIT_MS_BY_MOD, CATCH_UP_LIMIT_REASON, catchUpLimitMsFor } from './catch_up'
import { ServerOp } from './protocol'
import { type Lobby, disconnect, join, joinRejection, newLobby, setCatchingUp, tick, FORFEITED_SEAT } from './state'

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

	it('tells the forfeited seat, which is still connected, and kicks it', () => {
		const lobby = setCatchingUp(runningLobby('MultiplayerPvP'), 'b', true, 1000).lobby
		const step = tick(lobby, 1000 + LIMIT)
		expect(step.out).toContainEqual({
			kind: 'send',
			op: ServerOp.EVENT,
			payload: {
				type: 'player_kicked',
				lobbyCode: 'ABC123',
				playerId: 'b',
				displayName: 'b',
				data: { kickedBy: 'server', reason: CATCH_UP_LIMIT_REASON },
			},
			to: ['b'],
		})
		expect(step.out).toContainEqual({ kind: 'kick', userId: 'b' })
		// The others see the seat leave, as before.
		const toOthers = step.out.filter((o) => o.kind === 'send' && o.op === ServerOp.EVENT && o.to.indexOf('a') !== -1)
		expect(toOthers.map((o) => (o as { payload: { type: string } }).payload.type)).toEqual(['player_left'])
	})

	it('says nothing to, and kicks nobody for, a seat whose grace ran out (it is not connected)', () => {
		const away = disconnect(runningLobby('MultiplayerPvP'), 'b', 'b-s1', 1000).lobby
		const step = tick(away, 1000 + 120_000)
		expect(step.lobby.players.map((p) => p.id)).toEqual(['a'])
		expect(step.out.some((o) => o.kind === 'kick')).toBe(false)
		expect(step.out.some((o) => o.kind === 'send' && o.to.indexOf('b') !== -1)).toBe(false)
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

describe('the catch-up limit in the match loop', () => {
	afterEach(() => vi.restoreAllMocks())

	it('sends the forfeited seat its player_kicked event, then kicks its presence', () => {
		vi.spyOn(Date, 'now').mockReturnValue(1000 + LIMIT)
		const nk: any = fakeNk({ sha256Hash: (s: string) => `h${s.length}`, matchLabelUpdate: () => {} })
		const calls: string[] = []
		const dispatcher: any = {
			broadcastMessage: (op: number, data: string, to: { userId: string }[]) =>
				calls.push(`send ${op} ${JSON.parse(data).type} -> ${to.map((p) => p.userId).join(',')}`),
			matchKick: (who: { userId: string }[]) => calls.push(`kick ${who.map((p) => p.userId).join(',')}`),
			matchLabelUpdate: () => {},
		}
		const ctx: any = { ...playerCtx(''), matchId: 'm1' }
		const presence = (userId: string) => ({ userId, sessionId: `${userId}-s1`, username: userId, node: 'n' })
		const lobby = setCatchingUp(runningLobby('MultiplayerPvP'), 'b', true, 1000).lobby
		const state: any = { lobby, presences: { a: presence('a'), b: presence('b') }, pendingInfo: {}, label: '' }
		const after = lobbyMatchLoop(ctx, fakeLogger, nk, dispatcher, 1, state, [])
		const toB = calls.filter((c) => c.endsWith('-> b') || c.startsWith('kick'))
		expect(toB).toEqual([`send ${ServerOp.EVENT} player_kicked -> b`, 'kick b'])
		expect(after!.state.presences.b).toBeUndefined()
	})
})
