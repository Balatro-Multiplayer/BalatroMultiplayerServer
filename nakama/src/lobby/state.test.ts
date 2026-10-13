import { describe, expect, it } from 'vitest'
import { ServerOp } from './protocol'
import {
	CREATOR_JOIN_TIMEOUT_MS,
	type Lobby,
	type Outbound,
	type Step,
	disconnect,
	join,
	joinRejection,
	kick,
	labelOf,
	leave,
	newLobby,
	snapshotFor,
	setMetadata,
	setOwnState,
	setPlayerInfo,
	tick,
} from './state'

const GRACE = 10_000
const info = (name: string) => ({
	displayName: name,
	preferredJoker: null,
	mods: null,
})

function lobbyWith(...ids: string[]): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId: 'MultiplayerPvP',
		maxPlayers: 4,
		creatorId: ids[0],
		now: 0,
		graceMs: GRACE,
	})
	for (const id of ids) lobby = join(lobby, id, `${id}-s1`, info(id)).lobby
	return lobby
}

function events(
	step: Step,
): { type: string; playerId?: string; to: string[] }[] {
	return step.out
		.filter(
			(o): o is Extract<Outbound, { kind: 'send' }> =>
				o.kind === 'send' && o.op === ServerOp.EVENT,
		)
		.map((o) => ({
			...(o.payload as { type: string; playerId?: string }),
			to: o.to,
		}))
}

function eventTypes(step: Step): string[] {
	return events(step).map((e) => e.type)
}

describe('joinRejection', () => {
	it('keeps others out until the creator has joined', () => {
		const lobby = newLobby({
			code: 'ABC123',
			modId: 'm',
			maxPlayers: 2,
			creatorId: 'a',
			now: 0,
			graceMs: GRACE,
		})
		expect(joinRejection(lobby, 'b', 'm')).toBe('Lobby is not open yet')
		expect(joinRejection(lobby, 'a', 'm')).toBeNull()
	})

	it('rejects a full lobby, the wrong mod, and kicked players, but lets members back in', () => {
		let lobby = newLobby({
			code: 'ABC123',
			modId: 'm',
			maxPlayers: 2,
			creatorId: 'a',
			now: 0,
			graceMs: GRACE,
		})
		lobby = join(lobby, 'a', 'a-s1', info('a')).lobby
		expect(joinRejection(lobby, 'b', 'other')).toBe(
			'Lobby is for a different mod',
		)
		lobby = join(lobby, 'b', 'b-s1', info('b')).lobby
		expect(joinRejection(lobby, 'c', 'm')).toBe('Lobby is full')
		expect(joinRejection(lobby, 'b', 'm')).toBeNull()
		lobby = kick(lobby, 'a', 'b').lobby
		expect(joinRejection(lobby, 'b', 'm')).toBe(
			'You were kicked from this lobby',
		)
	})
})

describe('matchmade lobbies', () => {
	const made = () =>
		newLobby({
			code: 'ABCDE',
			modId: 'm',
			maxPlayers: 2,
			creatorId: 'a',
			rankedMode: 'mode',
			allowedIds: ['a', 'b'],
			now: 0,
			graceMs: GRACE,
		})

	it('seats only the matched players, in any order', () => {
		const lobby = made()
		expect(joinRejection(lobby, 'b', 'm')).toBeNull()
		expect(joinRejection(lobby, 'x', 'm')).toBe(
			'This lobby is reserved for matched players',
		)
	})

	it('makes whoever arrives first the host and reports the lobby as ranked', () => {
		const lobby = join(made(), 'b', 'b-s1', info('b')).lobby
		expect(lobby.hostId).toBe('b')
		expect(snapshotFor(lobby, 'b').type).toBe('ranked')
		expect(snapshotFor(lobbyWith('a'), 'a').type).toBe('private')
	})
})

describe('join', () => {
	it('sends the joiner a snapshot and tells the others', () => {
		const lobby = lobbyWith('a')
		const step = join(lobby, 'b', 'b-s1', info('b'))
		const snapshot = step.out.find(
			(o) => o.kind === 'send' && o.op === ServerOp.SNAPSHOT,
		)
		expect(snapshot).toMatchObject({
			to: ['b'],
			payload: {
				code: 'ABC123',
				hostId: 'a',
				players: [{ id: 'a' }, { id: 'b' }],
			},
		})
		expect(events(step)).toEqual([
			expect.objectContaining({
				type: 'player_joined',
				playerId: 'b',
				to: ['a'],
			}),
		])
		expect(step.out).toContainEqual({ kind: 'setCurrent', userId: 'b' })
		expect(JSON.parse(labelOf(step.lobby))).toMatchObject({
			code: 'ABC123',
			size: 2,
			open: true,
		})
	})
})

describe('leave', () => {
	it('removes the player, passes host on in join order, and kicks the presence', () => {
		const step = leave(lobbyWith('a', 'b', 'c'), 'a')
		expect(step.lobby.hostId).toBe('b')
		expect(step.lobby.players.map((p) => p.id)).toEqual(['b', 'c'])
		expect(eventTypes(step)).toEqual(['player_left', 'host_changed'])
		expect(events(step)[0].to).toEqual(['b', 'c'])
		expect(step.out).toContainEqual({ kind: 'kick', userId: 'a' })
		expect(step.out).toContainEqual({ kind: 'clearCurrent', userId: 'a' })
	})

	it('closes the lobby when the last player leaves', () => {
		const step = leave(lobbyWith('a'), 'a')
		expect(step.lobby.closed).toBe(true)
	})

	it('skips away players when passing host on', () => {
		let lobby = lobbyWith('a', 'b', 'c')
		lobby = disconnect(lobby, 'b', 'b-s1', 1).lobby
		expect(leave(lobby, 'a').lobby.hostId).toBe('c')
	})
})

describe('disconnect and grace period', () => {
	it('marks the player away, moves host on at once, and restores them on rejoin', () => {
		let lobby = lobbyWith('a', 'b')
		lobby = setOwnState(lobby, 'a', { seat: 1 }).lobby
		const dropped = disconnect(lobby, 'a', 'a-s1', 1000)
		expect(eventTypes(dropped)).toEqual(['player_disconnected', 'host_changed'])
		expect(dropped.lobby.hostId).toBe('b')
		expect(dropped.lobby.players[0].awaySince).toBe(1000)

		const back = join(dropped.lobby, 'a', 'a-s2', info('a'))
		expect(eventTypes(back)).toEqual(['player_reconnected'])
		expect(back.lobby.players[0]).toMatchObject({
			awaySince: null,
			sessionId: 'a-s2',
		})
		const snapshot = back.out.find(
			(o) => o.kind === 'send' && o.op === ServerOp.SNAPSHOT,
		)
		expect(snapshot).toMatchObject({
			payload: { ownState: { seat: 1 }, hostId: 'b' },
		})
	})

	it("ignores a stale session's leave after the player already rejoined", () => {
		let lobby = lobbyWith('a', 'b')
		lobby = join(lobby, 'b', 'b-s2', info('b')).lobby
		const step = disconnect(lobby, 'b', 'b-s1', 1000)
		expect(step.out).toEqual([])
		expect(step.lobby.players[1].awaySince).toBeNull()
	})

	it('drops an away player once the grace period runs out', () => {
		let lobby = lobbyWith('a', 'b')
		lobby = disconnect(lobby, 'b', 'b-s1', 1000).lobby
		expect(tick(lobby, 1000 + GRACE - 1).out).toEqual([])
		const expired = tick(lobby, 1000 + GRACE)
		expect(eventTypes(expired)).toEqual(['player_left'])
		expect(expired.lobby.players.map((p) => p.id)).toEqual(['a'])
	})

	it('closes the lobby straight away once nobody is connected', () => {
		let lobby = lobbyWith('a', 'b')
		lobby = disconnect(lobby, 'b', 'b-s1', 1000).lobby
		const step = disconnect(lobby, 'a', 'a-s1', 2000)
		expect(step.lobby.closed).toBe(true)
		expect(eventTypes(step)).toContain('lobby_closed')
		expect(step.out).toContainEqual({ kind: 'clearCurrent', userId: 'a' })
		expect(step.out).toContainEqual({ kind: 'clearCurrent', userId: 'b' })
	})
})

describe('kick', () => {
	it('is host only and never targets the host', () => {
		const lobby = lobbyWith('a', 'b')
		expect(kick(lobby, 'b', 'a').out).toEqual([
			{
				kind: 'send',
				op: ServerOp.ERROR,
				payload: { message: 'Only the host can kick players' },
				to: ['b'],
			},
		])
		expect(kick(lobby, 'a', 'a').lobby).toBe(lobby)
	})

	it('tells everyone, the target included, then removes and kicks them', () => {
		const step = kick(lobbyWith('a', 'b', 'c'), 'a', 'b')
		expect(events(step)).toEqual([
			expect.objectContaining({
				type: 'player_kicked',
				playerId: 'b',
				to: ['a', 'b', 'c'],
			}),
		])
		expect(step.lobby.players.map((p) => p.id)).toEqual(['a', 'c'])
		expect(step.lobby.kickedIds).toEqual(['b'])
		expect(step.out).toContainEqual({ kind: 'kick', userId: 'b' })
	})
})

describe('setMetadata', () => {
	it('shallow-merges host updates and broadcasts them', () => {
		let lobby = lobbyWith('a', 'b')
		lobby = setMetadata(lobby, 'a', { ruleset: 'standard', stake: 1 }).lobby
		const step = setMetadata(lobby, 'a', { stake: 2 })
		expect(step.lobby.metadata).toEqual({ ruleset: 'standard', stake: 2 })
		expect(step.out[0]).toMatchObject({
			op: ServerOp.METADATA,
			payload: { ruleset: 'standard', stake: 2 },
			to: ['a', 'b'],
		})
		expect(eventTypes(step)).toEqual(['metadata_changed'])
	})

	it('refuses non-hosts and non-objects', () => {
		const lobby = lobbyWith('a', 'b')
		expect(setMetadata(lobby, 'b', { x: 1 }).lobby).toBe(lobby)
		expect(setMetadata(lobby, 'a', [1, 2]).lobby).toBe(lobby)
	})
})

describe('tick', () => {
	it('closes a lobby its creator never joined', () => {
		const lobby = newLobby({
			code: 'ABC123',
			modId: 'm',
			maxPlayers: 2,
			creatorId: 'a',
			now: 0,
			graceMs: GRACE,
		})
		expect(tick(lobby, CREATOR_JOIN_TIMEOUT_MS - 1).lobby.closed).toBe(false)
		expect(tick(lobby, CREATOR_JOIN_TIMEOUT_MS).lobby.closed).toBe(true)
	})
})

describe('setPlayerInfo', () => {
	it('updates the player and tells everyone, the player too', () => {
		const step = setPlayerInfo(lobbyWith('a', 'b'), 'b', { displayName: 'Bee', preferredJoker: 'j_mime' })
		expect(step.lobby.players.find((p) => p.id === 'b')!.info).toEqual({ displayName: 'Bee', preferredJoker: 'j_mime', mods: null })
		expect(step.out).toEqual([
			{
				kind: 'send',
				op: ServerOp.PLAYER_INFO,
				payload: { playerId: 'b', info: { displayName: 'Bee', preferredJoker: 'j_mime', mods: null } },
				to: ['a', 'b'],
			},
		])
	})

	it('ignores players not in the lobby', () => {
		const lobby = lobbyWith('a')
		expect(setPlayerInfo(lobby, 'z', { displayName: 'Z' })).toEqual({ lobby, out: [] })
	})
})
