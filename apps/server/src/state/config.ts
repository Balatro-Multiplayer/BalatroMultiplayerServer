export interface ModConfig {
	modId: string
	displayName: string
	version: string
	downloadUrl: string
}

export interface AppConfig {
	tosVersion: number
	mods: ModConfig[]
	chatAllowlist: Set<string>
	// DB-backed (server_config.chat_enabled). Global chat kill-switch. When
	// falsy, the server rejects all chat sends.
	chatEnabled: boolean
	// Env-var only (env.TESTING_MODE), not admin-editable. When truthy, only
	// 'tester'-privileged players may create lobbies / queue.
	testingMode?: boolean
	// DB-backed (server_config.ranked_enabled). When falsy, ranked queue
	// requests are rejected; casual is unaffected.
	rankedEnabled: boolean
	// DB-backed (server_config.casual_queue_enabled). When falsy, non-ranked
	// queue requests are rejected; ranked is unaffected.
	casualQueueEnabled: boolean
	// DB-backed (server_config.lobby_creation_enabled). When falsy, manual
	// lobby creation (POST /lobbies) is rejected. Does NOT gate lobbies the
	// matchmaking system auto-creates on match found -- see rankedEnabled/
	// casualQueueEnabled for that.
	lobbyCreationEnabled: boolean
	// DB-backed (server_config.achievements_enabled). When falsy, Nakama
	// counts no games toward avatar achievements; locked avatars stay locked.
	achievementsEnabled: boolean
	// The rating season (seasons table): the active one, else the latest.
	// Pushed to Nakama, which rates games into it. Unset: no seasons yet.
	season?: number
}

let _config: AppConfig = {
	tosVersion: 1,
	mods: [],
	chatAllowlist: new Set(),
	chatEnabled: false,
	testingMode: false,
	rankedEnabled: true,
	casualQueueEnabled: true,
	lobbyCreationEnabled: true,
	achievementsEnabled: false,
}

export function getConfig(): AppConfig {
	return _config
}

export function setConfig(c: AppConfig): void {
	_config = c
}
