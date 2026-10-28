import { desc, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { serverConfig, modVersions, chatAllowlist, seasons, modRegistry } from '../db/schema.js'
import type { AppConfig } from '../../state/config.js'
import { setConfig } from '../../state/config.js'
import { env } from '../../env.js'
import { pushConfigToNakama } from '../nakama/config-sync.js'

// The active season (ended_at IS NULL), else the latest between seasons.
async function ratingSeason(): Promise<number | undefined> {
	const [active] = await db.select({ id: seasons.id }).from(seasons).where(isNull(seasons.endedAt)).limit(1)
	if (active) return active.id
	const [latest] = await db.select({ id: seasons.id }).from(seasons).orderBy(desc(seasons.id)).limit(1)
	return latest?.id
}

// The SMODS ids of every ranked-pinned mod: what Nakama lets a player
// report and still queue (with its own baseline ids and extras).
export async function pinnedSmodsIds(): Promise<string[]> {
	const rows = await db
		.select({ smodsIds: modRegistry.smodsIds })
		.from(modRegistry)
		.where(isNotNull(modRegistry.rankedVersion))
	return [...new Set(rows.flatMap((row) => row.smodsIds))].sort()
}

export async function loadConfigFromDb(): Promise<AppConfig> {
	await db
		.insert(serverConfig)
		.values({ id: 1 })
		.onConflictDoNothing()

	const configRow = await db.query.serverConfig.findFirst()

	const modRows = await db.query.modVersions.findMany()
	const mods = modRows.map((row) => ({
		modId: row.modId,
		displayName: row.displayName,
		version: row.version,
		downloadUrl: row.downloadUrl,
	}))

	const allowlistRows = await db.select().from(chatAllowlist)
	const chatAllowlistSet = new Set(allowlistRows.map((r) => r.message))

	const config: AppConfig = {
		season: await ratingSeason(),
		mods,
		chatAllowlist: chatAllowlistSet,
		chatEnabled: configRow?.chatEnabled ?? false,
		testingMode: env.TESTING_MODE,
		rankedEnabled: configRow?.rankedEnabled ?? true,
		casualQueueEnabled: configRow?.casualQueueEnabled ?? true,
		groupQueueEnabled: configRow?.groupQueueEnabled ?? true,
		lobbyCreationEnabled: configRow?.lobbyCreationEnabled ?? true,
		achievementsEnabled: configRow?.achievementsEnabled ?? true,
		queueAllowedModIds: await pinnedSmodsIds(),
	}
	setConfig(config)
	// Every config load (boot, admin refresh, webadmin edits) reaches Nakama.
	void pushConfigToNakama(config)
	return config
}
