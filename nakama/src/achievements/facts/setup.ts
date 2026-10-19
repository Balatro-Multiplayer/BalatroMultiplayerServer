// What a game was played with, from its framing events: the decks
// (run_info, one per Balatro run; lobby_info's deck list when no run got
// that far), the ruleset and the gamemode (lobby_info). Pure.
import { SPDRN_MODES, type SpdrnMode, type VanillaDeck } from '../../shared/avatars/rules'
import type { LogEvent } from '../../shared/replay/events'
import { deckKeyOf } from './decks'

const SMALLWORLD_RULESET = 'ruleset_mp_smallworld'

export interface GameSetup {
	decks: VanillaDeck[]
	smallworld: boolean
	spdrnMode: SpdrnMode | null
}

type Fields = { [field: string]: unknown }

function fieldsOf(args: unknown): Fields {
	return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Fields) : {}
}

function distinct<T>(values: (T | null)[]): T[] {
	const out: T[] = []
	for (const value of values) if (value !== null && out.indexOf(value) === -1) out.push(value)
	return out
}

export function spdrnModeOf(value: unknown): SpdrnMode | null {
	return typeof value === 'string' && (SPDRN_MODES as readonly string[]).indexOf(value) !== -1 ? (value as SpdrnMode) : null
}

// serverGamemode: the run record's options.gamemode (the host's start
// options, stored by the server), preferred over the log's own.
export function gameSetupOf(events: LogEvent[], serverGamemode: unknown = null): GameSetup {
	const lobbyInfo = fieldsOf((events.filter((e) => e.opcode === 'lobby_info')[0] || { args: null }).args)
	const lobbyOptions = fieldsOf(lobbyInfo.options)
	const runDecks = distinct(events.filter((e) => e.opcode === 'run_info').map((e) => deckKeyOf(fieldsOf(e.args).deck)))
	const lobbyDecks = Array.isArray(lobbyInfo.decks) ? distinct(lobbyInfo.decks.map(deckKeyOf)) : []
	const ruleset = lobbyInfo.ruleset ?? lobbyOptions.ruleset
	return {
		decks: runDecks.length > 0 ? runDecks : lobbyDecks,
		smallworld: ruleset === SMALLWORLD_RULESET,
		spdrnMode: spdrnModeOf(serverGamemode) || spdrnModeOf(lobbyInfo.gamemode) || spdrnModeOf(lobbyOptions.gamemode),
	}
}
