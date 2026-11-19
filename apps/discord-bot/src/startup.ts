// Startup errors a restart can't fix. main.ts exits 0 on these, so compose's
// `restart: on-failure` leaves the bot stopped instead of logging in to
// Discord again and again (many logins a day can get the token reset).
// Anything else (a network blip, Discord down) exits 1 and is restarted.

/** What to fix, or null when a restart may help. */
export function setupProblem(err: unknown): string | null {
	const e = err as { code?: unknown; status?: unknown } | null
	if (e?.code === 'TokenInvalid' || e?.status === 401)
		return 'Discord refused the token (DISCORD_BOT_TOKEN)'
	if (e?.status === 403)
		return 'Discord refused access: check the bot is in the server (DISCORD_GUILD_ID) and was invited with the bot and applications.commands scopes'
	if (e?.status === 404)
		return 'Discord does not know the server or application (DISCORD_GUILD_ID, DISCORD_BOT_CLIENT_ID)'
	return null
}

// Gateway close codes after which discord.js gives up for good.
const CLOSE_CODES: Record<number, string> = {
	4004: 'Discord refused the token (DISCORD_BOT_TOKEN)',
	4010: 'Discord refused the shard settings',
	4011: 'Discord requires sharding',
	4012: 'Discord refused the API version',
	4013: 'Discord refused the intents',
	4014: 'Server Members Intent is off (Developer Portal > Bot > Privileged Gateway Intents)',
}

/** What to fix when the gateway closed for good, or null when it reconnects. */
export function closeCodeProblem(code: number): string | null {
	return CLOSE_CODES[code] ?? null
}
