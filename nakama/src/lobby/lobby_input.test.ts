// The lobby stage's numbered inputs and view: Ready and Start take the same envelope as the match.
import { describe, expect, it } from 'vitest'
import {
	isLobbyInput,
	lobbyView,
	takeLobbyInput,
	takeSettingsInput,
} from './lobby_input'
import { ServerOp } from './protocol'
import { pvpHooks } from './pvp/match_hooks/pvp_shell'
import {
	PVP_PLAYER,
	SERVER_RULES,
	joinedLobby,
	relayCtx,
} from './pvp/testing/lobbies'
import { withRules } from './pvp/testing/rules'
import { type Lobby, disconnect, join, leave } from './state'

const ctx = (now: number) => relayCtx(now, 'run-1')

const ready = (number: number, value: boolean) => ({
	kind: 'lobbyReady',
	messageNumber: number,
	inboxDone: 0,
	runId: null,
	ready: value,
})
const settings = (number: number, patch: { [key: string]: unknown }) => ({
	kind: 'lobbySettings',
	messageNumber: number,
	inboxDone: 0,
	runId: null,
	settings: patch,
})
const start = (number: number) => ({
	kind: 'lobbyStart',
	messageNumber: number,
	inboxDone: 0,
	runId: null,
	stake: 1,
	options: { queue_mode: 'x' },
})

const team = (number: number, value: string) => ({
	kind: 'team',
	messageNumber: number,
	inboxDone: 0,
	runId: null,
	team: value,
})
const manhunt = (...ids: string[]): Lobby => ({
	...joinedLobby(ids),
	metadata: withRules({ queue_mode: 'pvp_manhunt' }),
})

describe('a team pick in the lobby', () => {
	it('is kept, numbered and shown in the view', () => {
		const lobby = manhunt('ann', 'bob', 'cy')
		const step = takeLobbyInput(lobby, 'cy', team(1, 'RUNNER'), ctx(1000))
		expect(step.refused).toBeUndefined()
		expect(lobbyView(step.lobby, 'ann', 1000).players.cy?.team).toBe('RUNNER')
		expect(lobbyView(step.lobby, 'ann', 1000).players.ann).toBeUndefined()
		expect(lobbyView(step.lobby, 'cy', 1000).lastMessageReceived).toBe(1)
		// A resend changes nothing.
		expect(
			takeLobbyInput(step.lobby, 'cy', team(1, 'HUNTER'), ctx(1001)).lobby
				.teamPicks,
		).toEqual({ cy: 'RUNNER' })
	})

	it('refuses a team the mode does not offer', () => {
		const step = takeLobbyInput(
			manhunt('ann', 'bob', 'cy'),
			'cy',
			team(1, 'A'),
			ctx(1000),
		)
		expect(step.refused?.reason).toBe('team_not_offered')
		expect(step.lobby.teamPicks ?? {}).toEqual({})
	})

	it('makes the player who picked Runner the Runner, not the first starter', () => {
		let lobby = manhunt('ann', 'bob', 'cy')
		lobby = takeLobbyInput(lobby, 'cy', team(1, 'RUNNER'), ctx(1000)).lobby
		for (const id of ['bob', 'cy'])
			lobby = takeLobbyInput(
				lobby,
				id,
				ready(id === 'cy' ? 2 : 1, true),
				ctx(1001),
			).lobby
		const step = takeLobbyInput(lobby, 'ann', start(1), ctx(1002))
		expect(step.lobby.game.pvp?.players.cy.team).toBe('RUNNER')
		const run = step.lobby.game.pvp?.run
		expect(run?.teams).toEqual({ ann: 'HUNTER', bob: 'HUNTER', cy: 'RUNNER' })
		expect([
			run?.lives.ann.lives,
			run?.lives.bob.lives,
			run?.lives.cy.lives,
		]).toEqual([7, 7, 1])
		expect(step.lobby.messageNumbers?.cy).toBe(2)
	})

	it.each([
		['A', 'B'],
		['B', 'A'],
	])(
		'puts a Teams pick of %s on side %s for the other player',
		(mine, theirs) => {
			let lobby: Lobby = {
				...joinedLobby(),
				metadata: withRules({ queue_mode: 'pvp_teams' }),
			}
			lobby = takeLobbyInput(lobby, 'ann', team(1, mine), ctx(1000)).lobby
			lobby = takeLobbyInput(lobby, 'bob', team(1, theirs), ctx(1000)).lobby
			expect(lobbyView(lobby, 'ann', 1).players.ann?.team).toBe(mine)
			expect(lobbyView(lobby, 'ann', 1).players.bob?.team).toBe(theirs)
		},
	)

	it('takes the number of a pick refused for want of a mode, so the next input is taken', () => {
		let lobby: Lobby = {
			...joinedLobby(),
			metadata: withRules({ queue_mode: undefined }),
		}
		const refused = takeLobbyInput(lobby, 'bob', team(1, 'RUNNER'), ctx(1000))
		expect(refused.refused?.reason).toBe('bad_rules')
		lobby = takeLobbyInput(
			refused.lobby,
			'bob',
			ready(2, true),
			ctx(1001),
		).lobby
		expect(lobbyView(lobby, 'bob', 1).match.lobby?.ready.bob).toBe(true)
	})

	it('the lobby view shows a picked player who is away as away', () => {
		const base = joinedLobby()
		const lobby: Lobby = {
			...base,
			players: base.players.map((seat) =>
				seat.id === 'bob' ? { ...seat, awaySince: 900 } : seat,
			),
			teamPicks: { ann: 'RUNNER', bob: 'HUNTER' },
		}
		const players = lobbyView(lobby, 'ann', 1).players
		expect(players.ann?.status).toBe('playing')
		expect(players.bob?.status).toBe('away')
	})

	it('a resend of a pick refused for want of a mode is not refused again', () => {
		const lobby: Lobby = {
			...joinedLobby(),
			metadata: withRules({ queue_mode: undefined }),
		}
		const first = takeLobbyInput(lobby, 'bob', team(1, 'RUNNER'), ctx(1000))
		const again = takeLobbyInput(
			first.lobby,
			'bob',
			team(1, 'RUNNER'),
			ctx(1500),
		)
		expect(again.refused).toBeUndefined()
		expect(again.lobby).toEqual(first.lobby)
	})

	it('a pick made during the Draft or Setup is kept for the next game too', () => {
		let lobby = manhunt('ann', 'bob', 'cy')
		for (const id of ['ann', 'bob', 'cy'])
			lobby = takeLobbyInput(lobby, id, ready(1, true), ctx(1000)).lobby
		lobby = takeLobbyInput(lobby, 'ann', start(2), ctx(1001)).lobby
		const pvp = lobby.game.pvp
		if (pvp === undefined) throw new Error('no match')
		// The match as it stands before its run: a pick goes to the match and is copied out.
		const unpicked = Object.fromEntries(
			Object.entries(pvp.players).map(([id, p]) => [id, { ...p, team: null }]),
		)
		const waiting = {
			...lobby,
			teamPicks: {},
			game: { ...lobby.game, pvp: { ...pvp, players: unpicked, run: null } },
		}
		const picked = pvpHooks.onInput(
			waiting,
			{ playerId: 'bob', session: 'bob-s1' },
			{
				kind: 'team',
				messageNumber: 2,
				inboxDone: 0,
				runId: null,
				team: 'RUNNER',
			},
			1002,
		)
		expect(picked.lobby.teamPicks).toEqual({ bob: 'RUNNER' })
		const again = pvpHooks.onRestart(picked.lobby, SERVER_RULES, 1003)
		if ('reject' in again) throw new Error(again.reject)
		expect(again.lobby.game.pvp?.run?.teams.bob).toBe('RUNNER')
	})

	it('forgets a pick when the player leaves, so a rejoin starts unpicked', () => {
		let lobby = manhunt('ann', 'bob', 'cy')
		lobby = takeLobbyInput(lobby, 'cy', team(1, 'RUNNER'), ctx(1000)).lobby
		lobby = leave(lobby, 'cy', 1001).lobby
		expect(lobby.teamPicks ?? {}).toEqual({})
		lobby = join(lobby, 'cy', 'cy-s2', PVP_PLAYER).lobby
		expect(lobbyView(lobby, 'cy', 1002).players.cy).toBeUndefined()
	})
})

describe('lobby inputs', () => {
	it('knows its kinds', () => {
		expect(isLobbyInput({ kind: 'lobbyReady' })).toBe(true)
		expect(isLobbyInput({ kind: 'lobbyStart' })).toBe(true)
		expect(isLobbyInput({ kind: 'team' })).toBe(true)
		expect(isLobbyInput({ kind: 'ready' })).toBe(false)
	})

	it('takes Ready once, in order, and shows it in the view', () => {
		const lobby = joinedLobby()
		const first = takeLobbyInput(lobby, 'bob', ready(1, true), ctx(1000))
		expect(lobbyView(first.lobby, 'bob', 1000).match.lobby?.ready).toEqual({
			ann: false,
			bob: true,
		})
		expect(lobbyView(first.lobby, 'bob', 1000).lastMessageReceived).toBe(1)
		// A resend changes nothing.
		const again = takeLobbyInput(first.lobby, 'bob', ready(1, true), ctx(1001))
		expect(again.lobby).toBe(first.lobby)
		// A gap is not taken.
		const gap = takeLobbyInput(first.lobby, 'bob', ready(3, false), ctx(1002))
		expect(gap.lobby).toBe(first.lobby)
	})

	it('ends on the latest Ready of the sender', () => {
		let lobby = joinedLobby()
		lobby = takeLobbyInput(lobby, 'bob', ready(1, true), ctx(1000)).lobby
		lobby = takeLobbyInput(lobby, 'bob', ready(2, false), ctx(1001)).lobby
		lobby = takeLobbyInput(lobby, 'bob', ready(3, true), ctx(1002)).lobby
		expect(lobbyView(lobby, 'bob', 1).match.lobby?.ready.bob).toBe(true)
	})

	it('ignores a sender with no seat', () => {
		const lobby = joinedLobby()
		expect(takeLobbyInput(lobby, 'eve', ready(1, true), ctx(1000)).lobby).toBe(
			lobby,
		)
	})

	it('starts the game and carries the number on', () => {
		let lobby = joinedLobby()
		lobby = takeLobbyInput(lobby, 'bob', ready(1, true), ctx(1000)).lobby
		const step = takeLobbyInput(lobby, 'ann', start(1), ctx(1001))
		expect(step.lobby.game.started?.runId).toBe('run-1')
		expect(step.lobby.messageNumbers?.ann).toBe(1)
		expect(step.lobby.startAnswers?.ann).toEqual({ number: 1, refused: null })
	})

	it('answers a refused Start in the view and loses nothing', () => {
		const lobby = joinedLobby()
		const step = takeLobbyInput(lobby, 'ann', start(1), ctx(1000))
		expect(step.lobby.game.started).toBeNull()
		expect(lobbyView(step.lobby, 'ann', 1).match.lobby?.start).toEqual({
			number: 1,
			refused: 'not_all_ready',
		})
		expect(
			step.out.some(
				(sent) => sent.kind === 'send' && sent.op === ServerOp.ACTION_REJECTED,
			),
		).toBe(false)
	})

	it('refuses Start while the guest is away, as it does today, in the view', () => {
		let lobby = joinedLobby()
		lobby = takeLobbyInput(lobby, 'bob', ready(1, true), ctx(1000)).lobby
		lobby = disconnect(lobby, 'bob', 'bob-s1', 1500).lobby
		const step = takeLobbyInput(lobby, 'ann', start(1), ctx(2000))
		expect(lobbyView(step.lobby, 'ann', 1).match.lobby?.start).toEqual({
			number: 1,
			refused: 'too_few_players',
		})
		expect(lobbyView(step.lobby, 'ann', 1).match.lobby?.away).toEqual(['bob'])
	})

	it('shows an answer only while its input is the latest', () => {
		let lobby = joinedLobby()
		lobby = takeLobbyInput(lobby, 'ann', start(1), ctx(1000)).lobby
		lobby = takeLobbyInput(lobby, 'ann', ready(2, true), ctx(1001)).lobby
		expect(lobbyView(lobby, 'ann', 1).match.lobby?.start).toBeNull()
	})

	it('takes the host settings once, in order, before and during the game', () => {
		let lobby = joinedLobby()
		const first = takeSettingsInput(lobby, 'ann', settings(1, { stake: '3' }))
		expect(first.lobby.metadata.stake).toBe('3')
		expect(lobbyView(first.lobby, 'ann', 1).lastMessageReceived).toBe(1)
		expect(
			takeSettingsInput(first.lobby, 'ann', settings(1, { stake: '3' })).lobby,
		).toBe(first.lobby)
		expect(
			takeSettingsInput(first.lobby, 'ann', settings(3, { stake: '5' })).lobby,
		).toBe(first.lobby)
		// In the game the number is the match's, and a later input there carries on from it.
		lobby = takeLobbyInput(first.lobby, 'bob', ready(1, true), ctx(1000)).lobby
		lobby = takeLobbyInput(lobby, 'ann', start(2), ctx(1001)).lobby
		const recipe = {
			cocktail_recipe: { name: 'x', decks: ['b_red', 'b_blue'] },
		}
		const inGame = takeSettingsInput(lobby, 'ann', settings(3, recipe))
		expect(inGame.lobby.metadata.cocktail_recipe).toEqual(
			recipe.cocktail_recipe,
		)
		expect(inGame.lobby.messageNumbers?.ann).toBe(3)
	})

	it('ignores a settings input from a seat that is not in the match, with the next number', () => {
		let lobby = joinedLobby()
		lobby = takeLobbyInput(lobby, 'bob', ready(1, true), ctx(1000)).lobby
		lobby = takeLobbyInput(lobby, 'ann', start(1), ctx(1001)).lobby
		const pvp = lobby.game.pvp
		if (pvp === undefined) throw new Error('no match')
		const without: Lobby = {
			...lobby,
			game: {
				...lobby.game,
				pvp: { ...pvp, players: { ann: pvp.players.ann } },
			},
		}
		const next = (without.messageNumbers?.bob ?? 0) + 1
		const step = takeSettingsInput(
			without,
			'bob',
			settings(next, { stake: '8' }),
		)
		expect(step.lobby).toBe(without)
		expect(step.lobby.messageNumbers).toBe(without.messageNumbers)
	})

	it("takes a guest's settings input without changing the settings or failing the guest", () => {
		const lobby = joinedLobby()
		const step = takeSettingsInput(lobby, 'bob', settings(1, { stake: '8' }))
		expect(step.lobby.metadata.stake).toBe(lobby.metadata.stake)
		expect(step.lobby.messageNumbers?.bob).toBe(1)
		expect(step.out).toEqual([])
	})

	it('a dropped settings input arrives on its resend, and the latest one wins', () => {
		const inputs = [
			settings(1, { stake: '1' }),
			settings(2, { stake: '4' }),
			settings(3, { stake: '6' }),
		]
		for (const dropped of [0, 1, 2]) {
			let lobby = joinedLobby()
			for (const [index, input] of inputs.entries())
				if (index !== dropped)
					lobby = takeSettingsInput(lobby, 'ann', input).lobby
			for (const input of inputs)
				lobby = takeSettingsInput(lobby, 'ann', input).lobby
			expect(lobby.metadata.stake).toBe('6')
			expect(lobbyView(lobby, 'ann', 1).lastMessageReceived).toBe(3)
		}
	})

	it('for any input, dropping its first send still ends confirmed', () => {
		// The client resends every unconfirmed input; the server takes the first one that arrives.
		const inputs = [ready(1, true), ready(2, false), ready(3, true)]
		for (const dropped of [0, 1, 2]) {
			let lobby = joinedLobby()
			for (const [index, input] of inputs.entries()) {
				// Order and resends as the client makes them: an input lost once is sent again.
				if (index !== dropped)
					lobby = takeLobbyInput(lobby, 'bob', input, ctx(1000 + index)).lobby
			}
			// Whatever was missed arrives on the resend, then the later ones again.
			for (const input of inputs)
				lobby = takeLobbyInput(lobby, 'bob', input, ctx(2000)).lobby
			const shown = lobbyView(lobby, 'bob', 1)
			expect(shown.lastMessageReceived).toBe(3)
			expect(shown.match.lobby?.ready.bob).toBe(true)
		}
	})
})
