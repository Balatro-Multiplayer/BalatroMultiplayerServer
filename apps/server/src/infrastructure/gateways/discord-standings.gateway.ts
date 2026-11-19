import { desc, inArray, lt, sql } from 'drizzle-orm'
import { effectiveRating } from '../../features/ratings/effective-rating.js'
import { db } from '../db/index.js'
import { players, seasons } from '../db/schema.js'

// Reads for the Discord rank-role bot (features/discord-bot). The board order
// itself comes from stats.gateway.ts leaderboardPage, the public board's query.

export interface BoardSeason {
	modId: string
	gameMode: string
	seasonId: number
}

export interface BoardRating {
	gamesPlayed: number
	/** The rating the board shows (effectiveRating: decay applied). */
	rating: number
}

/** Player id per Discord id hash, for the hashes a player has linked. */
export async function playerIdsByDiscordIdHash(
	hashes: string[],
): Promise<Map<string, string>> {
	if (hashes.length === 0) return new Map()
	const rows = await db
		.select({ id: players.id, hash: players.discordIdHash })
		.from(players)
		.where(inArray(players.discordIdHash, hashes))
	const byHash = new Map<string, string>()
	for (const row of rows) if (row.hash) byHash.set(row.hash, row.id)
	return byHash
}

/** The players' rows on one board, keyed by player id. No row = no games. */
export async function boardRatings(
	board: BoardSeason,
	playerIds: string[],
): Promise<Map<string, BoardRating>> {
	if (playerIds.length === 0) return new Map()
	const res = await db.execute(sql`
		SELECT r.player_id, r.games_played, ${effectiveRating} AS rating
		FROM matchmaking_ratings r
		WHERE r.mod_id = ${board.modId} AND r.game_mode = ${board.gameMode} AND r.season = ${board.seasonId}
		  AND ${inArray(sql`r.player_id`, playerIds)}
	`)
	const byPlayer = new Map<string, BoardRating>()
	for (const row of res.rows) {
		const r = row as {
			player_id: string
			games_played: number | string
			rating: number | string
		}
		byPlayer.set(r.player_id, {
			gamesPlayed: Number(r.games_played),
			rating: Number(r.rating),
		})
	}
	return byPlayer
}

/** The season before `seasonId`, or null when it is the first. */
export async function previousSeasonId(
	seasonId: number,
): Promise<number | null> {
	const [row] = await db
		.select({ id: seasons.id })
		.from(seasons)
		.where(lt(seasons.id, seasonId))
		.orderBy(desc(seasons.id))
		.limit(1)
	return row?.id ?? null
}
