// The game that ended stays in the lobby until the next game starts: the lobby view goes on
// showing its result, so a player whose frame, connection or rejoin comes after the end still
// reads how the game ended. A player's end screen (`endGame`) comes after the result and
// belongs to that game; the changed ended view goes down to the players.
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PVP_MOD_ID } from '../../../standing/pvp_version'
import { lobbyView } from '../../lobby_input'
import { type Lobby, join, newLobby } from '../../state'
import { PVP_PLAYER, endedLobby, sendAction } from '../testing/lobbies'
import { changedViews } from './last_view_sent'
import { pvpHooks } from './pvp_shell'

describe('the game that ended, in the lobby view', () => {
	it('keeps the result once the game is closed', () => {
		const lobby = endedLobby()
		expect(lobby.game.started).toBeNull()
		expect(lobbyView(lobby, 'ann', 6000).match.ended?.match.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rated: false,
		})
		expect(lobbyView(lobby, 'bob', 6000).match.ended?.match.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rated: false,
		})
		// The finish screen reads the run and the players of the game that ended.
		const ann = lobbyView(lobby, 'ann', 6000)
		expect(ann.match.stage).toBe('lobby')
		expect(ann.match.ended?.me).toBe('ann')
		expect(ann.match.ended?.match.run).not.toBeNull()
		expect(Object.keys(ann.match.ended?.players ?? {}).sort()).toEqual([
			'ann',
			'bob',
		])
	})

	it('keeps it while the players get Ready for the next game', () => {
		const lobby = sendAction(
			endedLobby(),
			'bob',
			'mpapi_ready',
			{ ready: true },
			7000,
		)
		const shown = lobbyView(lobby, 'ann', 7000)
		expect(shown.match.lobby?.ready.bob).toBe(true)
		expect(shown.match.ended?.match.result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rated: false,
		})
	})

	it('is gone once the next game starts', () => {
		const back = sendAction(
			endedLobby(),
			'bob',
			'mpapi_ready',
			{ ready: true },
			7000,
		)
		const next = sendAction(back, 'ann', 'mpapi_start_game', { stake: 1 }, 8000)
		expect(next.game.started).not.toBeNull()
		expect(next.game.pvp?.result).toBeNull()
		expect(next.game.ended).toBeUndefined()
	})

	it('shows no result in a lobby that has not played a game', () => {
		const fresh = newLobby({
			code: 'ABC123',
			modId: PVP_MOD_ID,
			maxPlayers: 8,
			creatorId: 'ann',
			now: 0,
			graceMs: 120_000,
		})
		const shown = lobbyView(
			join(fresh, 'ann', 'ann-s1', PVP_PLAYER).lobby,
			'ann',
			0,
		)
		expect(shown.match.result).toBeNull()
		expect(shown.match.run).toBeNull()
		expect(shown.players).toEqual({})
	})
})

const endGameOf = (
	lobby: Lobby,
	player: string,
	tag: string,
	number?: number,
): unknown => {
	const run = lobby.game.ended?.run
	if (!run) throw new Error('no run in the ended game')
	return {
		kind: 'endGame',
		runId: run.id,
		messageNumber: number ?? (lobby.messageNumbers?.[player] ?? 0) + 1,
		inboxDone: 0,
		jokers: `${tag}-jokers`,
		deck: `${tag}-deck`,
		stats: { rerollCount: 3, rerollCostTotal: 12 },
	}
}

const input = (lobby: Lobby, player: string, message: unknown, now = 6000) =>
	pvpHooks.onInput(
		lobby,
		{ playerId: player, session: `${player}-s1` },
		message,
		now,
	)

describe('endGame after the result', () => {
	it('reaches the other player in the ended view, never the sender own', () => {
		let lobby = endedLobby()
		expect(lobby.game.pvp).toBeUndefined()
		expect(lobby.game.ended?.result?.kind).toBe('win')
		for (const player of ['ann', 'bob']) {
			const taken = input(lobby, player, endGameOf(lobby, player, player))
			expect(taken.refusals).toEqual([])
			lobby = taken.lobby
		}
		const forAnn = lobbyView(lobby, 'ann', 7000).match.ended
		const forBob = lobbyView(lobby, 'bob', 7000).match.ended
		expect(forAnn?.players.bob.endGame).toEqual({
			jokers: 'bob-jokers',
			deck: 'bob-deck',
			stats: { rerollCount: 3, rerollCostTotal: 12 },
		})
		expect(forBob?.players.ann.endGame).toEqual({
			jokers: 'ann-jokers',
			deck: 'ann-deck',
			stats: { rerollCount: 3, rerollCostTotal: 12 },
		})
		expect(forAnn?.players.ann.endGame).toBeUndefined()
		expect(forBob?.players.bob.endGame).toBeUndefined()
	})

	it('changes the lobby view, so the views path sends it', () => {
		const lobby = endedLobby()
		const ids = ['ann', 'bob']
		const first = changedViews({}, ids, (id) => lobbyView(lobby, id, 6000))
		const after = input(lobby, 'bob', endGameOf(lobby, 'bob', 'bob')).lobby
		const second = changedViews(first.sent, ids, (id) =>
			lobbyView(after, id, 6100),
		)
		// Ann reads bob's end screen; bob's own view moves by his acknowledged input number.
		expect(second.views.map((v) => v.player)).toEqual(['ann', 'bob'])
		expect(second.views[0].view.match.ended?.players.bob.endGame?.jokers).toBe(
			'bob-jokers',
		)
		expect(
			second.views[1].view.match.ended?.players.bob.endGame,
		).toBeUndefined()
	})

	it('keeps the lobby numbers one sequence into the next game', () => {
		const lobby = endedLobby()
		const after = input(lobby, 'ann', endGameOf(lobby, 'ann', 'ann')).lobby
		expect(after.messageNumbers?.ann).toBe((lobby.messageNumbers?.ann ?? 0) + 1)
	})

	it('drops an input from a stale session', () => {
		const lobby = endedLobby()
		const taken = pvpHooks.onInput(
			lobby,
			{ playerId: 'bob', session: 'old' },
			endGameOf(lobby, 'bob', 'bob'),
			6000,
		)
		expect(taken.lobby).toBe(lobby)
	})

	it('is cleared with the ended game at the next start', () => {
		let lobby = endedLobby()
		lobby = input(lobby, 'ann', endGameOf(lobby, 'ann', 'ann')).lobby
		lobby = sendAction(lobby, 'bob', 'mpapi_ready', { ready: true }, 7000)
		lobby = sendAction(lobby, 'ann', 'mpapi_start_game', { stake: 1 }, 8000)
		expect(lobby.game.ended).toBeUndefined()
		expect(lobby.game.pvp?.run?.endGames).toEqual({})
	})

	// Well-formed bodies of kinds whose handlers do not look at the result: only the ended game
	// refusing them keeps the run as it was.
	const OTHER_KINDS: { [kind: string]: { [field: string]: unknown } } = {
		blindResult: { blindKey: '2:Boss', result: 'lost' },
		progress: { ante: 3, location: 'shop' },
		handPlayed: { blindKey: '2:Boss', handsLeft: 2 },
		handScored: { blindKey: '2:Boss', handsLeft: 2, score: '100' },
		blindStart: { blindKey: '2:Boss', handsLeft: 4, score: '0' },
		forfeit: {},
		vote: {},
		nonsense: {},
	}

	const END_GAME_BODY = {
		jokers: 'j',
		deck: 'd',
		stats: { rerollCount: 0, rerollCostTotal: 0 },
	}

	const withoutEndGames = (state: Lobby['game']['ended']) => ({
		...state?.run,
		endGames: {},
	})

	it.each(Object.keys(OTHER_KINDS))(
		'%s with a valid body leaves the ended run as it was',
		(kind) => {
			const lobby = endedLobby()
			const run = lobby.game.ended?.run
			const taken = input(lobby, 'bob', {
				kind,
				runId: run?.id ?? null,
				messageNumber: (lobby.messageNumbers?.bob ?? 0) + 1,
				inboxDone: 0,
				...OTHER_KINDS[kind],
			})
			expect(withoutEndGames(taken.lobby.game.ended)).toEqual(
				withoutEndGames(lobby.game.ended),
			)
			expect(taken.lobby.game.ended?.result).toEqual(lobby.game.ended?.result)
			expect(taken.lobby.messageNumbers?.bob).toBe(
				(lobby.messageNumbers?.bob ?? 0) + 1,
			)
		},
	)

	it('property: after the result, input from any seat changes nothing in the run but the end screens', () => {
		const lobby = endedLobby()
		const before = lobby.game.ended
		const kinds = ['endGame', ...Object.keys(OTHER_KINDS)]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						player: fc.constantFrom('ann', 'bob', 'cat'),
						kind: fc.constantFrom(...kinds),
						inOrder: fc.boolean(),
						number: fc.integer({ min: 0, max: 6 }),
					}),
					{ maxLength: 12 },
				),
				(steps) => {
					let now = lobby
					for (const step of steps) {
						const run = now.game.ended?.run
						now = input(now, step.player, {
							kind: step.kind,
							runId: run?.id ?? null,
							messageNumber: step.inOrder
								? (now.messageNumbers?.[step.player] ?? 0) + 1
								: step.number,
							inboxDone: 0,
							...(step.kind === 'endGame'
								? END_GAME_BODY
								: OTHER_KINDS[step.kind]),
						}).lobby
					}
					const after = now.game.ended
					expect(after?.result).toEqual(before?.result)
					expect(withoutEndGames(after)).toEqual(withoutEndGames(before))
				},
			),
		)
	})
})
