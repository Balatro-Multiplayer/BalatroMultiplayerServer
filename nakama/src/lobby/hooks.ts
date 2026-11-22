// Who referees a lobby's PvP, and the types the server's answers use. A game the
// players referee takes the lobby core's own path, line for line.
import {
	PVP_MOD_ID,
	belowMinimum,
	everyoneOnServerRules,
} from '../standing/pvp_version'
import type { GameState, Placement, RunStatus } from './protocol'
import type { Lobby } from './state'

export interface Refusal {
	reject: string
}

// What a game the server referees says about how its run ended; null while it is not over.
export interface Ending {
	status: RunStatus
	placements: Placement[]
}

// 'not_pvp' is a lobby of another mod.
export type Referee = 'server' | 'players' | 'not_pvp'

// Who refereed a game: what it was started with. A game saved before that was written was
// the server's if it holds a PvP match.
export function savedReferee(game: GameState): 'server' | 'players' {
	const referee = game.started?.referee
	if (referee !== undefined) return referee
	return game.pvp !== undefined ? 'server' : 'players'
}

// Who referees the running game.
export function runningReferee(lobby: Lobby): Referee | 'no_game' {
	if (lobby.modId !== PVP_MOD_ID) return 'not_pvp'
	return lobby.game.started === null ? 'no_game' : savedReferee(lobby.game)
}

// Who would referee a game started now: the server when the setting is set and every
// seated player reports at least that version.
export function nextReferee(
	lobby: Lobby,
	rulesVersion: string,
): 'server' | 'players' {
	const versions = lobby.players.map((seat) => seat.info.pvpVersion)
	return everyoneOnServerRules(rulesVersion, versions) ? 'server' : 'players'
}

// The running game's referee; with no game running, the one a start would have now.
export function refereeOf(lobby: Lobby, rulesVersion: string): Referee {
	const running = runningReferee(lobby)
	return running === 'no_game' ? nextReferee(lobby, rulesVersion) : running
}

// A player below the lowest PvP version the server allows takes no seat in any PvP
// lobby, whoever referees it.
export function joinRefusal(
	lobby: Lobby,
	playerId: string,
	minimumVersion: string,
): Refusal | null {
	if (lobby.modId !== PVP_MOD_ID) return null
	const seat = lobby.players.find((player) => player.id === playerId)
	return belowMinimum(seat?.info.pvpVersion, minimumVersion)
		? { reject: 'pvp_update_required' }
		: null
}
