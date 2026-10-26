// Nakama's own database, reached directly only by the Steam id rewrite
// (scripts/rewrite-steam-ids.ts), which runs while Nakama is stopped.

// Logins still named by a raw Steam id: accounts with custom id
// "steam:<id>" and ban index entries keyed "custom:steam:<id>".
export interface RawSteamLogins {
	accounts: { userId: string; steamId: string }[]
	bannedSteamIds: string[]
}

export interface SteamIdRewritePlan {
	accounts: { userId: string; customId: string }[]
	banKeys: { from: string; to: string }[]
}

export interface INakamaAccountRepository {
	findRawSteamLogins(): Promise<RawSteamLogins>
	// All of it or none of it.
	applySteamIdRewrite(plan: SteamIdRewritePlan): Promise<void>
	countRawSteamLogins(): Promise<number>
}
