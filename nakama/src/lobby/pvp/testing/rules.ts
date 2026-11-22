// Test support: a complete set of the lobby metadata keys the rules freeze from, as
// the client writes them (PVP.pvp_lobby_metadata, lobby defaults in the PvP mod's
// core.lua). The server invents no default for a missing key, so a test that starts
// a game carries these; a test overrides the key it is about.
import { type PvpSettings, settingsFromLobby } from '../rules/settings'

export const FULL_RULES: { [key: string]: unknown } = {
	ruleset: 'ruleset_mp_traditional',
	queue_mode: 'pvp_nemesis',
	starting_lives: 4,
	manhunt_hunter_lives: 7,
	pvp_start_ante: 2,
	timer_base_seconds: 150,
	timer_forgiveness: 0,
	timer_increment_seconds: null,
}

// FULL_RULES with the given keys replaced; a key set to `undefined` is removed.
export function withRules(overrides: { [key: string]: unknown } = {}): {
	[key: string]: unknown
} {
	const merged = { ...FULL_RULES, ...overrides }
	for (const key of Object.keys(merged))
		if (merged[key] === undefined) delete merged[key]
	return merged
}

// The settings of metadata known to be valid. A bad key throws.
export function settingsAtStart(
	lobbySettings: { [key: string]: unknown },
	startedIds: string[],
): PvpSettings {
	const result = settingsFromLobby(lobbySettings, startedIds)
	if (!result.ok) throw new Error(`bad_rules: ${result.key}`)
	return result.settings
}
