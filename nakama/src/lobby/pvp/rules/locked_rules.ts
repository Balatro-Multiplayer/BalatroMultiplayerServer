import { clockSettingOf } from './settings'

// A ranked lobby plays the rules of the queue its players joined. The client
// queues one ticket per ruleset ("pvp_ranked_<short>", pvp_api/queue.lua), always as
// a 2-player Nemesis lobby on the client's lobby defaults (core.lua). The server pins
// those keys and refuses a host write that differs, before and after the freeze.

const RANKED_PREFIX = 'pvp_ranked_'
const RANKED_RULESETS: readonly string[] = [
	'balanced',
	'expanded',
	'vanilla',
	'majorleague',
	'smallworld',
]

type LockedRules = { [key: string]: string | number }
type LockedRulesResult =
	| { ok: true; locked: LockedRules }
	| { ok: false; reason: 'unknown_ranked_mode' }

export function lockedRulesForRankedMode(
	rankedMode: string,
): LockedRulesResult {
	if (!rankedMode.startsWith(RANKED_PREFIX))
		return { ok: false, reason: 'unknown_ranked_mode' }
	const shortName = rankedMode.slice(RANKED_PREFIX.length)
	if (!RANKED_RULESETS.includes(shortName))
		return { ok: false, reason: 'unknown_ranked_mode' }
	const ruleset = `ruleset_mp_${shortName}`
	const found = clockSettingOf(ruleset)
	if (!found.ok) return { ok: false, reason: 'unknown_ranked_mode' }
	const locked: LockedRules = {
		ruleset,
		queue_mode: 'pvp_nemesis',
		starting_lives: 4,
		pvp_start_ante: 2,
		// The client's lobby default (core.lua) and what flow.lua sends: `or 7`.
		manhunt_hunter_lives: 7,
	}
	// A league ruleset forces its own base and forgiveness: nothing to pin there.
	if (!found.clock.forcedTimer) {
		locked.timer_base_seconds = 150
		locked.timer_forgiveness = 0
	}
	locked.timer_increment_seconds = 60
	return { ok: true, locked }
}

// Casual lobbies and other mods are not pinned; an unknown PvP ranked mode is refused.
// The caller passes in the id of the PvP mod.
export function lockedRulesFor(
	modId: string,
	rankedMode: string,
	pvpModId: string,
): LockedRulesResult {
	if (modId !== pvpModId || rankedMode === '') return { ok: true, locked: {} }
	return lockedRulesForRankedMode(rankedMode)
}
