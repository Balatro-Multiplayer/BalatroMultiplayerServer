// At boot, QUEUE_ALLOWED_MOD_IDS_EXTRA (the runtime env; local stacks set it
// in nakama/local.yml, a real server never does) is added to the stored
// queueAllowedModIdsExtra, so test clients' dev mods (MultiplayerPvP,
// ClaudeControl) stay allowed across restarts. Ids already there are kept:
// the seed only adds.
import { readConfig, writeConfig } from '../config'
import { parseExtraSeed, seededExtra } from './allowed'

export const EXTRA_SEED_ENV = 'QUEUE_ALLOWED_MOD_IDS_EXTRA'

export function seedAllowedModIdsExtra(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	env: { [key: string]: string },
) {
	const raw = env[EXTRA_SEED_ENV]
	const seed = parseExtraSeed(raw)
	if (!seed) {
		if (raw !== undefined && raw.trim() !== '') logger.warn('%s ignored: not a list of mod ids', EXTRA_SEED_ENV)
		return
	}
	const config = readConfig(nk)
	const extra = seededExtra(config.queueAllowedModIdsExtra, seed)
	if (!extra) return
	writeConfig(nk, { ...config, queueAllowedModIdsExtra: extra })
	logger.info('Seeded queueAllowedModIdsExtra from %s: %v', EXTRA_SEED_ENV, JSON.stringify(extra))
}
