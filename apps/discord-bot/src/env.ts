import { type Ladder, managedRoleNames } from './ladders.js'

// Every Discord-side value comes from the environment. A missing or malformed
// required one disables the bot (main.ts logs one line and exits 0).

export interface BotConfig {
	token: string
	clientId: string
	guildId: string
	/** Role name (as in ladders.ts) -> Discord role id. */
	roleIds: Record<string, string>
	apiUrl: string
	apiKey: string
	syncIntervalMs: number
	dryRun: boolean
}

export type ConfigResult =
	| { ok: true; config: BotConfig }
	| { ok: false; problems: string[] }

const SNOWFLAKE = /^\d{17,20}$/
export const MAX_SYNC_MINUTES = 24 * 60

export function roleEnvName(role: string): string {
	return `DISCORD_ROLE_${role.toUpperCase()}`
}

export function loadConfig(
	env: NodeJS.ProcessEnv,
	ladders: Ladder[],
): ConfigResult {
	const missing: string[] = []
	const invalid: string[] = []
	const read = (key: string, snowflake = false): string => {
		const value = env[key]?.trim() ?? ''
		if (!value) missing.push(key)
		else if (snowflake && !SNOWFLAKE.test(value)) invalid.push(key)
		return value
	}

	const token = read('DISCORD_BOT_TOKEN')
	const clientId = read('DISCORD_BOT_CLIENT_ID', true)
	const guildId = read('DISCORD_GUILD_ID', true)
	const apiKey = read('DISCORD_BOT_API_KEY')
	const roleIds: Record<string, string> = {}
	for (const role of managedRoleNames(ladders))
		roleIds[role] = read(roleEnvName(role), true)

	const seen = new Map<string, string>()
	for (const [role, id] of Object.entries(roleIds)) {
		if (!id) continue
		const other = seen.get(id)
		if (other)
			invalid.push(`${roleEnvName(role)} (same role as ${roleEnvName(other)})`)
		seen.set(id, role)
	}

	// At most a day: setInterval can't wait longer than about 24.8 days and
	// fires at once instead, so a huge value would sweep nonstop.
	const minutes = Number(env.SYNC_INTERVAL_MINUTES?.trim() || '10')
	if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_SYNC_MINUTES)
		invalid.push('SYNC_INTERVAL_MINUTES')

	// On unless set to false: the first real sweep strips roles from many
	// members, so it has to be previewed first.
	const dryRunRaw = (env.DRY_RUN ?? '').trim().toLowerCase()
	const dryRun = !(dryRunRaw === 'false' || dryRunRaw === '0')

	const problems = [
		...(missing.length ? [`missing ${missing.join(', ')}`] : []),
		...(invalid.length ? [`invalid ${invalid.join(', ')}`] : []),
	]
	if (problems.length) return { ok: false, problems }

	return {
		ok: true,
		config: {
			token,
			clientId,
			guildId,
			roleIds,
			apiUrl: (env.BMP_API_URL?.trim() || 'http://api:8788').replace(
				/\/+$/,
				'',
			),
			apiKey,
			syncIntervalMs: minutes * 60_000,
			dryRun,
		},
	}
}
