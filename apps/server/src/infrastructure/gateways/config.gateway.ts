import { desc, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { serverConfig, modVersions, chatAllowlist, seasons } from '../db/schema.js'
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

export async function loadConfigFromDb(): Promise<AppConfig> {
	await db
		.insert(serverConfig)
		.values({ id: 1, tosVersion: 1 })
		.onConflictDoNothing()

	const configRow = await db.query.serverConfig.findFirst()
	const tosVersion = configRow?.tosVersion ?? 1

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
		tosVersion,
		mods,
		chatAllowlist: chatAllowlistSet,
		chatEnabled: configRow?.chatEnabled ?? false,
		testingMode: env.TESTING_MODE,
		rankedEnabled: configRow?.rankedEnabled ?? true,
		casualQueueEnabled: configRow?.casualQueueEnabled ?? true,
		groupQueueEnabled: configRow?.groupQueueEnabled ?? true,
		lobbyCreationEnabled: configRow?.lobbyCreationEnabled ?? true,
		achievementsEnabled: configRow?.achievementsEnabled ?? false,
	}
	setConfig(config)
	// Every config load (boot, admin refresh, webadmin edits) reaches Nakama.
	void pushConfigToNakama(config)
	return config
}
