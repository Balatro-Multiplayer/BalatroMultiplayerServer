import { describe, expect, it } from 'vitest'
import { settle } from '../actions/results'
import { runningReferee } from './hooks'
import { action } from './relay'
import type { Outbound } from './state'
import { type Lobby, join, newLobby } from './state'

const info = (name: string) => ({
	displayName: name,
	preferredJoker: null,
	mods: null,
})

const ctx = (now: number) => ({
	now,
	newSeed: () => 'SEED',
	newId: () => 'RUN1',
	random: () => 0,
})

function send(
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown,
	now: number,
) {
	return action(
		lobby,
		from,
		{ cid: `${key}-${from}`, action: key, to: 'server', params },
		ctx(now),
	)
}

function startedLobby(modId: string): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId,
		maxPlayers: 8,
		creatorId: 'a',
		now: 0,
		graceMs: 10_000,
		resultTimeoutMs: 60_000,
	})
	for (const id of ['a', 'b'])
		lobby = join(lobby, id, `${id}-s1`, info(id)).lobby
	lobby = send(lobby, 'b', 'mpapi_ready', { ready: true }, 1000).lobby
	return send(lobby, 'a', 'mpapi_start_game', { stake: 2 }, 1000).lobby
}

const saved = (out: Outbound[]) =>
	out.find(
		(o): o is Extract<Outbound, { kind: 'saveRun' }> => o.kind === 'saveRun',
	)?.run

describe('a lobby with no hooks', () => {
	const places = [
		{ playerId: 'b', place: 1 },
		{ playerId: 'a', place: 2 },
	]

	it.each(['MultiplayerSPDRN', 'SomeOtherMod'])(
		'settles on the reports, as before (%s)',
		(modId) => {
			const lobby = startedLobby(modId)
			expect(runningReferee(lobby)).toBe('not_pvp')
			const first = send(
				lobby,
				'a',
				'mpapi_report_result',
				{ placements: places },
				2000,
			)
			expect(saved(first.out)).toBeUndefined()
			const last = send(
				first.lobby,
				'b',
				'mpapi_report_result',
				{ placements: places },
				2500,
			)
			expect(saved(last.out)?.status).toBe('agreed')
			expect(last.lobby.game.started).toBeNull()
		},
	)

	it.each(['MultiplayerSPDRN', 'SomeOtherMod'])(
		'still ends on the report clock (%s)',
		(modId) => {
			const lobby = startedLobby(modId)
			const reported = send(
				lobby,
				'a',
				'mpapi_report_result',
				{ placements: places },
				2000,
			)
			expect(saved(reported.out)).toBeUndefined()
			const ended = settle(settle(reported.lobby, 2001).lobby, 2001 + 60_000)
			expect(saved(ended.out)?.status).toBe('partial')
		},
	)
})
