// A player's standing right now, from what is stored: the server config, the
// launcher verdict (integrity.ts) and this session's mod report.
import { readConfig, type ServerConfig } from '../config'
import { isVerified, readIntegrity } from '../integrity'
import { allowedModIds } from './allowed'
import { standingOf, type StandingResult } from './standing'
import { readModReport } from './storage'

export function standingFor(
	nk: nkruntime.Nakama,
	userId: string,
	now: number,
	config: ServerConfig = readConfig(nk),
): StandingResult {
	return standingOf({
		verified: isVerified(readIntegrity(nk, userId), now),
		report: readModReport(nk, userId),
		allowedIds: allowedModIds(config),
		enforced: config.queueModsEnforced,
	})
}

// What account_standing, profile_set_mods and STANDING_CHANGED answer with:
// the standing, and whether mods are checked at all (with enforcement off
// everyone unverified is valid).
export interface StandingView extends StandingResult {
	enforced: boolean
}

export function standingViewFor(
	nk: nkruntime.Nakama,
	userId: string,
	now: number,
	config: ServerConfig = readConfig(nk),
): StandingView {
	return { ...standingFor(nk, userId, now, config), enforced: config.queueModsEnforced }
}
