// The game a player is still in, for rejoining after a crash. Pure.
import type { ActiveRun } from './protocol'
import type { Lobby } from './state'

// null unless a game is running and userId is one of its participants still
// seated in the lobby. The events are the player's own log so far, parsed
// from the JSON text they arrived as into {t, opcode, args}.
export function activeRunOf(lobby: Lobby, userId: string): ActiveRun | null {
	const started = lobby.game.started
	if (!started || lobby.closed) return null
	if (!started.players.some((p) => p.id === userId)) return null
	if (!lobby.players.some((p) => p.id === userId)) return null
	const log = lobby.game.logs[userId]
	return {
		runId: started.runId,
		code: lobby.code,
		modId: lobby.modId,
		events: (log ? log.lines : []).map((line) => {
			const [t, opcode, args] = JSON.parse(line) as unknown[]
			return { t, opcode, args }
		}),
	}
}
