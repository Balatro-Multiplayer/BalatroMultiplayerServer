// POST /internal/discord-bot/* (apps/server features/discord-bot), which only
// the Discord rank-role bot (apps/discord-bot) calls.

/** A Discord id (snowflake) as text. */
export const DISCORD_ID_PATTERN = /^\d{17,20}$/

/** Most Discord ids one /standings request may carry. */
export const DISCORD_BOT_MAX_IDS = 1000

/** One row of a board as the bot needs it. */
export interface DiscordBotRating {
	gamesPlayed: number
	/** The rating the public board shows (decay applied). */
	rating: number
}

export interface DiscordBotMember {
	/** The player linked to this Discord account. */
	playerId: string
	/** This season's row on the board; null = no games yet. */
	current: DiscordBotRating | null
	/** Last season's final row on the same board; null = no games then. */
	previous: DiscordBotRating | null
}

export interface DiscordBotStandingsRequest {
	modId: string
	gameMode: string
	/** How many places of the board to return in `top` (0 = none). */
	topN: number
	discordIds: string[]
}

export interface DiscordBotStandingsAnswer {
	season: number
	previousSeason: number | null
	/** Keyed by Discord id. A missing id has no linked player. */
	players: Record<string, DiscordBotMember>
	/**
	 * Player ids of the first `topN` places of the public board, in order
	 * (rank 1 first). Read in the same snapshot as `players`. A bot that reads
	 * its members over several requests ranks them all from one request's
	 * list, so a match between two requests can't give two members #1.
	 */
	top: string[]
}
