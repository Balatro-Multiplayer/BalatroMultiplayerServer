// A player's input number belongs to the player in the lobby: a new game carries it on.
import { describe, expect, it } from 'vitest'
import { restartedStep } from '../../../actions/registry'
import { finishGame } from '../../../actions/results'
import type { Lobby } from '../../state'
import { readyLobby, relayCtx, sendAction, startGame } from '../testing/lobbies'
import { pvpHooks } from './pvp_shell'

// One input the way the mod sends it: the number, the run it names, and a body.
function input(
	lobby: Lobby,
	player: string,
	messageNumber: number,
	runId: string | null,
): Lobby {
	return pvpHooks.onInput(
		lobby,
		{ playerId: player, session: `${player}-s1` },
		{
			messageNumber,
			inboxDone: 0,
			runId,
			kind: 'ready',
			ready: true,
			blindKey: '2:Boss',
		},
		3000,
	).lobby
}

const numberOf = (lobby: Lobby, player: string) =>
	lobby.messageNumbers?.[player] ?? 0

function playUntil(lobby: Lobby, last: number): Lobby {
	let current = lobby
	for (let n = 1; n <= last; n++)
		current = input(current, 'ann', n, current.game.pvp?.run?.id ?? null)
	return current
}

const backInLobby = (lobby: Lobby): Lobby => {
	const finished = finishGame(lobby, 5000, {
		status: 'abandoned',
		announce: false,
	}).lobby
	return sendAction(finished, 'bob', 'mpapi_ready', { ready: true }, 6000)
}

describe('the input number across games of one lobby', () => {
	it('starts a first game at 0', () => {
		const lobby = startGame(readyLobby())
		expect(numberOf(lobby, 'ann')).toBe(0)
		expect(numberOf(lobby, 'bob')).toBe(0)
	})

	it('carries on into a new game started in the same lobby', () => {
		const first = playUntil(startGame(readyLobby()), 4)
		expect(numberOf(first, 'ann')).toBe(4)
		const second = startGame(backInLobby(first))
		expect(second.game.started?.runId).not.toBe(first.game.started?.runId)
		expect(numberOf(second, 'ann')).toBe(4)
		expect(numberOf(second, 'bob')).toBe(0)
		const taken = input(second, 'ann', 5, second.game.pvp?.run?.id ?? null)
		expect(numberOf(taken, 'ann')).toBe(5)
	})

	it('uses up the number of an input left over from the earlier run and changes nothing in the new run', () => {
		const first = playUntil(startGame(readyLobby()), 4)
		const oldRun = first.game.pvp?.run?.id ?? null
		const second = startGame(backInLobby(first))
		const leftOver = input(second, 'ann', 5, oldRun)
		expect(numberOf(leftOver, 'ann')).toBe(5)
		expect(leftOver.game.pvp?.run).toEqual(second.game.pvp?.run)
		const next = input(leftOver, 'ann', 6, second.game.pvp?.run?.id ?? null)
		expect(numberOf(next, 'ann')).toBe(6)
	})

	it('carries on into the game a seed vote restarts', () => {
		const first = playUntil(startGame(readyLobby()), 3)
		const step = restartedStep(first, relayCtx(6000))
		if ('reject' in step) throw new Error(step.reject)
		const second = step.lobby
		expect(second.game.started?.runId).not.toBe(first.game.started?.runId)
		expect(numberOf(second, 'ann')).toBe(3)
		const taken = input(second, 'ann', 4, second.game.pvp?.run?.id ?? null)
		expect(numberOf(taken, 'ann')).toBe(4)
	})

	it('shows the carried number in the player view', () => {
		const second = startGame(backInLobby(playUntil(startGame(readyLobby()), 4)))
		const shown = pvpHooks.views(second, {}, 7000).out
		const mine = shown.find(
			(out) => out.kind === 'send' && out.to.includes('ann'),
		)
		expect(JSON.stringify(mine)).toContain('"lastMessageReceived":4')
	})

	it('keeps the number through a checkpoint', () => {
		const second = startGame(backInLobby(playUntil(startGame(readyLobby()), 4)))
		const restored = JSON.parse(JSON.stringify(second)) as Lobby
		expect(numberOf(pvpHooks.onResume(restored, 1000), 'ann')).toBe(4)
	})
})
