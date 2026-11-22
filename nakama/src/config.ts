// Server-wide switches. The BMP API (Express) owns them -- webadmin edits
// them in Postgres -- and pushes every change here through admin_config_set,
// so they live in one system-owned storage object. Read it on each use:
// every Nakama JavaScript VM has its own globals, so a cached copy would go
// stale on the others.
import { SYSTEM_USER_ID } from './lobby/protocol'
import type { PvpLimits } from './lobby/pvp/core/types'

export const CONFIG_COLLECTION = 'server_config'
export const CONFIG_KEY = 'global'

export interface ServerConfig {
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
	// Finished games count toward avatar achievements (achievements/record.ts).
	// Locked avatars stay locked either way.
	achievementsEnabled: boolean
	// Chat messages that skip moderation, as webadmin lists them (looked up by
	// chat/filter.ts normalizeForAllowlist).
	chatAllowlist: string[]
	// The API's active rating season (rating/season.ts); 0 until pushed.
	season: number
	// The SMODS ids of the ranked-pinned mods, as the API pushes them.
	queueAllowedModIds: string[]
	// More allowed ids, set here only (test harnesses' dev mods, seeded at
	// boot from QUEUE_ALLOWED_MOD_IDS_EXTRA -- standing/seed.ts); the API
	// never sends it, so its pushes leave it be.
	queueAllowedModIdsExtra: string[]
	// The PvP limits a run freezes when it starts (lobby/pvp). Server only.
	pvpLimits: PvpLimits
	// The lowest PvP mod version (X.Y.Z) allowed to play PvP; '' for no minimum. Keep it at or
	// above pvpServerRulesVersion, or an older joiner can move a new lobby back to the players.
	pvpMinVersion: string
	// The lowest PvP mod version (X.Y.Z) every player in a lobby needs for the server to referee its PvP; '' keeps PvP with the players.
	pvpServerRulesVersion: string
}

interface LimitRange {
	fallback: number
	min: number
	max: number
}

// Every PvP limit: its default and the whole numbers it may be set to.
export const PVP_LIMIT_RANGES: { [limit in keyof PvpLimits]: LimitRange } = {
	animatingHoldMilliseconds: { fallback: 300_000, min: 1_000, max: 900_000 },
	animatingBlindMilliseconds: { fallback: 600_000, min: 1_000, max: 1_800_000 },
	awayBudgetMilliseconds: { fallback: 120_000, min: 0, max: 1_800_000 },
}

const LIMIT_NAMES = Object.keys(PVP_LIMIT_RANGES) as (keyof PvpLimits)[]

// current with each limit of raw that is a whole number inside its range; any
// other value leaves that one limit as it was.
export function mergePvpLimits(current: PvpLimits, raw: unknown): PvpLimits {
	if (typeof raw !== 'object' || raw === null) return current
	const given = raw as { [key: string]: unknown }
	const next = { ...current }
	for (const name of LIMIT_NAMES) {
		const value = given[name]
		const { min, max } = PVP_LIMIT_RANGES[name]
		if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) next[name] = value
	}
	return next
}

export const DEFAULT_PVP_LIMITS: PvpLimits = {
	animatingHoldMilliseconds: PVP_LIMIT_RANGES.animatingHoldMilliseconds.fallback,
	animatingBlindMilliseconds: PVP_LIMIT_RANGES.animatingBlindMilliseconds.fallback,
	awayBudgetMilliseconds: PVP_LIMIT_RANGES.awayBudgetMilliseconds.fallback,
}

export function parsePvpLimits(raw: unknown): PvpLimits {
	return mergePvpLimits(DEFAULT_PVP_LIMITS, raw)
}

const MIN_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

// Until the API's first push: everything Nakama already did stays allowed.
export const DEFAULT_CONFIG: ServerConfig = {
	chatEnabled: true,
	rankedEnabled: true,
	casualQueueEnabled: true,
	groupQueueEnabled: true,
	lobbyCreationEnabled: true,
	testingMode: false,
	integrityEnforced: false,
	achievementsEnabled: true,
	chatAllowlist: [],
	season: 0,
	queueAllowedModIds: [],
	queueAllowedModIdsExtra: [],
	pvpLimits: DEFAULT_PVP_LIMITS,
	pvpMinVersion: '',
	pvpServerRulesVersion: '',
}

const MAX_MOD_IDS = 500
const MOD_ID_PATTERN = /^[^\s]{1,128}$/

export function modIdsOf(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_MOD_IDS) return null
	if (!value.every((id) => typeof id === 'string' && MOD_ID_PATTERN.test(id))) return null
	return value as string[]
}

// current with every valid field of update applied; unknown keys and wrongly
// typed values are ignored.
export function mergeConfig(current: ServerConfig, update: { [key: string]: unknown }): ServerConfig {
	const next: ServerConfig = { ...current }
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
		'achievementsEnabled',
	]
	for (const flag of flags) {
		const value = update[flag]
		if (typeof value === 'boolean') (next as unknown as { [k: string]: unknown })[flag] = value
	}
	const allowlist = update.chatAllowlist
	if (Array.isArray(allowlist) && allowlist.every((m) => typeof m === 'string'))
		next.chatAllowlist = allowlist as string[]
	const allowedIds = modIdsOf(update.queueAllowedModIds)
	if (allowedIds) next.queueAllowedModIds = allowedIds
	const extraIds = modIdsOf(update.queueAllowedModIdsExtra)
	if (extraIds) next.queueAllowedModIdsExtra = extraIds
	next.pvpLimits = mergePvpLimits(current.pvpLimits, update.pvpLimits)
	const minVersion = update.pvpMinVersion
	if (typeof minVersion === 'string' && (minVersion === '' || MIN_VERSION_PATTERN.test(minVersion)))
		next.pvpMinVersion = minVersion
	const rulesVersion = update.pvpServerRulesVersion
	if (typeof rulesVersion === 'string' && (rulesVersion === '' || MIN_VERSION_PATTERN.test(rulesVersion)))
		next.pvpServerRulesVersion = rulesVersion
	return next
}

export type ClientConfig = Omit<
	ServerConfig,
	'chatAllowlist' | 'queueAllowedModIds' | 'queueAllowedModIdsExtra' | 'pvpLimits' | 'pvpMinVersion' | 'pvpServerRulesVersion'
>

// What a client is shown (the login response): the switches, not the
// moderators' allowlist nor the mod allowlists (account_standing answers
// for those).
export function clientConfig(config: ServerConfig): ClientConfig {
	const { chatAllowlist, queueAllowedModIds, queueAllowedModIdsExtra, pvpLimits, pvpMinVersion, pvpServerRulesVersion, ...shown } = config
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
