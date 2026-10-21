import { describe, expect, it } from 'vitest'
import { ServerOp } from './protocol'
import { action } from './relay'
import {
	MAX_SPECTATORS,
	addSpectator,
	isSpectator,
	removeSpectator,
	snapshotEntry,
	spectatableLobbies,
	spectateRejection,
	spectateSnapshot,
} from './spectate'
import { type Lobby, type Outbound, type Step, close, join, joinRejection, kick, labelOf, newLobby } from './state'

const info = (name: string) => ({ displayName: name, preferredJoker: null, mods: null })

// A private lobby unless `matched` lists its matchmade players (public).
function lobbyWith(ids: string[], matched = false): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId: 'MultiplayerPvP',
		maxPlayers: 4,
		creatorId: ids[0],
		allowedIds: matched ? ids : undefined,
		now: 0,
		graceMs: 10_000,
	})
	for (const id of ids) lobby = join(lobby, id, `${id}-s1`, info(id)).lobby
	return lobby
}

const ctx = { now: 1000, newSeed: () => 'SEED1234', newId: () => 'RUN1' }
const send = (lobby: Lobby, from: string, data: { [key: string]: unknown }) => action(lobby, from, data, ctx)

function started(lobby: Lobby): Lobby {
	for (const id of lobby.players.map((p) => p.id).slice(1))
		lobby = send(lobby, id, { cid: 'r', action: 'mpapi_ready', to: 'server', params: { ready: true } }).lobby
	return send(lobby, lobby.hostId, { cid: 's', action: 'mpapi_start_game', to: 'server', params: {} }).lobby
}

function logEvent(lobby: Lobby, from: string, t: number, opcode: string, args: unknown): Step {
	return send(lobby, from, { cid: `l${t}`, action: 'mpapi_log_event', to: 'server', params: { t, opcode, args } })
}

type Send = Extract<Outbound, { kind: 'send' }>
const sends = (step: Step, op: number) => step.out.filter((o): o is Send => o.kind === 'send' && o.op === op)

describe('spectateRejection', () => {
	it('lets anyone watch a public (matchmade) lobby, playing or not', () => {
		expect(spectateRejection(lobbyWith(['a', 'b'], true), 'z', '')).toBeNull()
		expect(spectateRejection(started(lobbyWith(['a', 'b'], true)), 'z', '')).toBeNull()
	})

	it('only lets a private lobby be watched once its host made it spectatable', () => {
		const lobby = lobbyWith(['a', 'b'])
		expect(spectateRejection(lobby, 'z', '')).toBe('This lobby is not spectatable')
		const open = { ...lobby, metadata: { spectatable: true } }
		expect(spectateRejection(open, 'z', '')).toBeNull()
	})

	it('refuses kicked players, seated players, a closed lobby and a full gallery', () => {
		let lobby = lobbyWith(['a', 'b', 'c'], true)
		lobby = kick(lobby, 'a', 'c').lobby
		expect(spectateRejection(lobby, 'c', '')).toBe('You have been kicked from this lobby')
		expect(spectateRejection(lobby, 'b', '')).toBe('You are playing in this lobby')
		expect(spectateRejection(close(lobby).lobby, 'z', '')).toBe('Lobby is closed')
		const full = { ...lobby, spectators: Array.from({ length: MAX_SPECTATORS }, (_, i) => `s${i}`) }
		expect(spectateRejection(full, 'z', '')).toBe('This lobby has too many spectators')
		// Someone already watching (reconnecting) is let back in.
		expect(spectateRejection(full, 's3', '')).toBeNull()
	})

	it('refuses a spectator from another mod, but not one that names no mod', () => {
		const lobby = started(lobbyWith(['a', 'b'], true))
		expect(spectateRejection(lobby, 'z', 'MultiplayerSPDRN')).toBe('Lobby is for a different mod')
		expect(spectateRejection(lobby, 'z', 'MultiplayerPvP')).toBeNull()
		expect(spectateRejection(lobby, 'z', '')).toBeNull()
	})

	it('keeps a spectator out of a seat', () => {
		const lobby = addSpectator(lobbyWith(['a', 'b'], true), 'z').lobby
		expect(joinRejection(lobby, 'z', 'MultiplayerPvP')).toBe('You are spectating this lobby')
	})
})

describe('spectators in the lobby', () => {
	it('are counted in the label but never seated', () => {
		const step = addSpectator(lobbyWith(['a', 'b'], true), 'z')
		expect(isSpectator(step.lobby, 'z')).toBe(true)
		expect(step.lobby.players.map((p) => p.id)).toEqual(['a', 'b'])
		expect(JSON.parse(labelOf(step.lobby))).toMatchObject({ size: 2, spectators: 1, spectatable: true })
		expect(removeSpectator(step.lobby, 'z').lobby.spectators).toEqual([])
	})

	it('get the snapshot on joining', () => {
		const step = addSpectator(lobbyWith(['a', 'b'], true), 'z')
		const [snapshot] = sends(step, ServerOp.SPECTATE_SNAPSHOT)
		expect(snapshot.to).toEqual(['z'])
		expect(snapshot.payload).toEqual({ code: 'ABC123', modId: 'MultiplayerPvP', runId: null, players: [], snapshot: [] })
	})

	it('get every participant replay event, and nothing else', () => {
		let lobby = started(lobbyWith(['a', 'b'], true))
		lobby = addSpectator(lobby, 'z').lobby
		const step = logEvent(lobby, 'a', 5, 'hand_result', ['100', 3])
		expect(sends(step, ServerOp.SPECTATE_EVENT)).toEqual([
			{
				kind: 'send',
				op: ServerOp.SPECTATE_EVENT,
				payload: { playerId: 'a', t: 5, opcode: 'hand_result', args: ['100', 3] },
				to: ['z'],
			},
		])
		// The participants' own relay never reaches the spectator.
		for (const sent of sends(step, ServerOp.ACTION)) expect(sent.to).not.toContain('z')
		const chat = send(lobby, 'a', { cid: 'x', action: 'pvp_thing', to: '*', params: {} })
		expect(sends(chat, ServerOp.SPECTATE_EVENT)).toEqual([])
	})

	it('cannot act as a player', () => {
		const lobby = addSpectator(started(lobbyWith(['a', 'b'], true)), 'z').lobby
		const step = logEvent(lobby, 'z', 1, 'hand_result', ['1', 1])
		expect(step.out).toEqual([])
		expect(step.lobby.game.logs.z).toBeUndefined()
	})

	it('hear the lobby close', () => {
		const lobby = addSpectator(lobbyWith(['a', 'b'], true), 'z').lobby
		const [closed] = sends(close(lobby), ServerOp.EVENT)
		expect(closed.to).toEqual(['a', 'b', 'z'])
	})
})

describe('spectateSnapshot', () => {
	it('starts each participant from the latest ante and hand, the first lobby_info and the latest run_info', () => {
		let lobby = started(lobbyWith(['a', 'b'], true))
		const events: [string, number, string, unknown][] = [
			['b', 0, 'set_ante_key', ['bl_small']],
			['a', 0, 'lobby_info', { gamemode: 'pvp_smallworld', ruleset: 'ruleset_mp_smallworld', options: { sleeve: 'sleeve_none', challenge: '' } }],
			['a', 1, 'lobby_info', { gamemode: 'later', ruleset: 'ignored' }],
			['a', 2, 'run_info', { seed: 'ABCD1234', deck: 'Red Deck', stake: 1 }],
			['a', 3, 'set_ante_key', ['bl_small']],
			['a', 4, 'hand_result', ['12345', 3]],
			['a', 5, 'set_ante_key', ['bl_big']],
			['a', 6, 'run_info', { seed: 'WXYZ5678', deck: 'Blue Deck', stake: 2 }],
			['a', 7, 'hand_result', ['67890', 2]],
		]
		for (const [from, t, opcode, args] of events) lobby = logEvent(lobby, from, t, opcode, args).lobby
		expect(spectateSnapshot(lobby)).toEqual({
			code: 'ABC123',
			modId: 'MultiplayerPvP',
			runId: 'RUN1',
			players: [
				{ playerId: 'a', displayName: 'a' },
				{ playerId: 'b', displayName: 'b' },
			],
			snapshot: [
				{
					playerId: 'a',
					ante: 'bl_big',
					score: '67890',
					handsRemaining: 2,
					manifest: {
						seed: 'WXYZ5678',
						deck: 'Blue Deck',
						stake: 2,
						ruleset: 'ruleset_mp_smallworld',
						gamemode: 'pvp_smallworld',
						sleeve: 'sleeve_none',
						challenge: '',
					},
				},
				{ playerId: 'b', ante: 'bl_small', score: null, handsRemaining: null, manifest: null },
			],
		})
	})

	it('leaves the manifest out until both lobby_info and run_info are in', () => {
		const line = JSON.stringify([0, 'lobby_info', { gamemode: 'g', ruleset: 'r' }])
		expect(snapshotEntry('p', [line, 'not json']).manifest).toBeNull()
	})
})

describe('spectatableLobbies', () => {
	it('lists watchable lobbies from their labels', () => {
		const watchable = labelOf(lobbyWith(['a', 'b'], true))
		const hidden = labelOf(lobbyWith(['c', 'd']))
		const full = JSON.stringify({ ...JSON.parse(watchable), code: 'FULL01', spectators: MAX_SPECTATORS })
		expect(spectatableLobbies([watchable, hidden, full, 'garbage'])).toEqual([
			{ code: 'ABC123', modId: 'MultiplayerPvP', playerCount: 2, started: false, spectators: 0 },
		])
	})
})
