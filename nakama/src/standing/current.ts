// A player's standing right now, from what is stored: the server config, the
// launcher verdict (integrity.ts) and this session's mod report, with the
// allowed mods checked only where the server kind says so. What
// account_standing, profile_set_mods and STANDING_CHANGED answer with.
import { readConfig, type ServerConfig } from '../config'
import { isVerified, readIntegrity } from '../integrity'
import type { ServerSettings } from '../server_kind'
import { allowedModIds } from './allowed'
import { standingOf, type StandingResult } from './standing'
import { readModReport } from './storage'

export function standingFor(
	nk: nkruntime.Nakama,
	settings: ServerSettings,
	userId: string,
	now: number,
	config: ServerConfig = readConfig(nk),
): StandingResult {
	return standingOf({
		verified: isVerified(readIntegrity(nk, userId), now),
		report: readModReport(nk, userId),
		allowedIds: settings.allowedModsChecked ? allowedModIds(config) : 'any',
	})
}
