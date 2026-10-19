// Server-wide switches. The BMP API (Express) owns them -- webadmin edits
// them in Postgres -- and pushes every change here through admin_config_set,
// so they live in one system-owned storage object. Read it on each use:
// every Nakama JavaScript VM has its own globals, so a cached copy would go
// stale on the others.
import { SYSTEM_USER_ID } from './lobby/protocol'

export const CONFIG_COLLECTION = 'server_config'
export const CONFIG_KEY = 'global'

export interface ServerConfig {
	tosVersion: number
	chatEnabled: boolean
	rankedEnabled: boolean
	casualQueueEnabled: boolean
	// A private lobby may queue casual matchmaking as one group
	// (matchmaking/group); its members still need casualQueueEnabled.
	groupQueueEnabled: boolean
	lobbyCreationEnabled: boolean
	// Only 'tester'-privileged players may create lobbies or queue.
	testingMode: boolean
	// Ranked needs a launcher-integrity verdict from the API.
	integrityEnforced: boolean
	// Chat messages that skip moderation, as webadmin lists them (looked up by
	// chat/filter.ts normalizeForAllowlist).
	chatAllowlist: string[]
	// The API's active rating season (rating/season.ts); 0 until pushed.
	season: number
}

// Until the API's first push: everything Nakama already did stays allowed.
export const DEFAULT_CONFIG: ServerConfig = {
	tosVersion: 1,
	chatEnabled: true,
	rankedEnabled: true,
	casualQueueEnabled: true,
	groupQueueEnabled: true,
	lobbyCreationEnabled: true,
	testingMode: false,
	integrityEnforced: false,
	chatAllowlist: [],
	season: 0,
}

// current with every valid field of update applied; unknown keys and wrongly
// typed values are ignored.
export function mergeConfig(current: ServerConfig, update: { [key: string]: unknown }): ServerConfig {
	const next: ServerConfig = { ...current }
	const tos = update.tosVersion
	if (typeof tos === 'number' && Number.isInteger(tos) && tos >= 0) next.tosVersion = tos
	const season = update.season
	if (typeof season === 'number' && Number.isInteger(season) && season > 0) next.season = season
	const flags: (keyof ServerConfig)[] = [
		'chatEnabled',
		'rankedEnabled',
		'casualQueueEnabled',
		'groupQueueEnabled',
		'lobbyCreationEnabled',
		'testingMode',
		'integrityEnforced',
	]
	for (const flag of flags) {
		const value = update[flag]
		if (typeof value === 'boolean') (next as unknown as { [k: string]: unknown })[flag] = value
	}
	const allowlist = update.chatAllowlist
	if (Array.isArray(allowlist) && allowlist.every((m) => typeof m === 'string'))
		next.chatAllowlist = allowlist as string[]
	return next
}

// What a client is shown (the login response): the switches, not the
// moderators' allowlist.
export function clientConfig(config: ServerConfig): Omit<ServerConfig, 'chatAllowlist'> {
	const { chatAllowlist, ...shown } = config
	return shown
}

export function readConfig(nk: nkruntime.Nakama): ServerConfig {
	const objects = nk.storageRead([{ collection: CONFIG_COLLECTION, key: CONFIG_KEY, userId: SYSTEM_USER_ID }])
	return mergeConfig(DEFAULT_CONFIG, objects.length > 0 ? objects[0].value : {})
}

export function writeConfig(nk: nkruntime.Nakama, config: ServerConfig) {
	nk.storageWrite([
		{
			collection: CONFIG_COLLECTION,
			key: CONFIG_KEY,
			userId: SYSTEM_USER_ID,
			value: config as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}
