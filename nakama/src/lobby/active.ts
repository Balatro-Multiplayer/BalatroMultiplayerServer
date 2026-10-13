// The game a player is still in, for rejoining after a crash or a dropped
// connection. Pure.
import type { ActiveRun, PlayerLog, ReplayEvent, ReplayTail } from './protocol'
import type { Lobby } from './state'

// null unless a game is running and userId is one of its participants still
// seated in the lobby. The events are the player's own log so far, parsed
// from the JSON text they arrived as into {t, opcode, args}.
export function activeRunOf(lobby: Lobby, userId: string): ActiveRun | null {
	const started = lobby.game.started
	if (!started || lobby.closed) return null
	if (!started.players.some((p) => p.id === userId)) return null
	if (!lobby.players.some((p) => p.id === userId)) return null
	return {
		runId: started.runId,
		code: lobby.code,
		modId: lobby.modId,
		events: eventsOf(lobby.game.logs[userId]),
	}
}

// What a participant rejoining a running game missed of the others (the
// API's replay-tail push): every other participant's log that has anything
// in it, or null when there's nothing to send.
export function replayTailOf(lobby: Lobby, userId: string): ReplayTail | null {
	const started = lobby.game.started
	if (!started || lobby.closed) return null
	if (!started.players.some((p) => p.id === userId)) return null
	const tails = started.players
		.filter((p) => p.id !== userId)
		.map((p) => ({ playerId: p.id, events: eventsOf(lobby.game.logs[p.id]) }))
		.filter((tail) => tail.events.length > 0)
	return tails.length > 0 ? { runId: started.runId, tails } : null
}

function eventsOf(log: PlayerLog | undefined): ReplayEvent[] {
	return (log ? log.lines : []).map((line) => {
		const [t, opcode, args] = JSON.parse(line) as unknown[]
		return { t, opcode, args }
	})
}
