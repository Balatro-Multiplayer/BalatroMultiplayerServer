import type { DiscordBotRating } from '@bmp/types'
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { effectiveRating } from '../../features/ratings/effective-rating.js'
import { PLACEMENT_GAMES } from '../../features/ratings/elo.js'
import { db } from '../db/index.js'
import { matchmakingRatings, players, seasons } from '../db/schema.js'
import type { Tx } from './rating.gateway.js'
import { leaderboardOrder } from './stats.gateway.js'

// Reads for the Discord rank-role bot (features/discord-bot).

export interface BoardSeason {
	modId: string
	gameMode: string
	seasonId: number
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

/** The board reads one answer needs, all in one snapshot. */
export interface BoardReads {
	/** The players' rows on one board, keyed by player id. No row = no games. */
	boardRatings(
		board: BoardSeason,
		playerIds: string[],
	): Promise<Map<string, DiscordBotRating>>
	/** Player ids of the public board's first `n` places, in order. */
	topPlayerIds(board: BoardSeason, n: number): Promise<string[]>
	/** Rows on the board written after `since` (mmr_updated_idx). */
	playersChangedSince(
		board: BoardSeason,
		since: Date,
	): Promise<{ playerId: string; updatedAt: Date }[]>
}

function boardReads(tx: Tx): BoardReads {
	return {
		async boardRatings(board, playerIds) {
			if (playerIds.length === 0) return new Map()
			const res = await tx.execute(sql`
				SELECT r.player_id, r.games_played, ${effectiveRating} AS rating
				FROM matchmaking_ratings r
				WHERE r.mod_id = ${board.modId} AND r.game_mode = ${board.gameMode} AND r.season = ${board.seasonId}
				  AND ${inArray(sql`r.player_id`, playerIds)}
			`)
			const byPlayer = new Map<string, DiscordBotRating>()
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
		},

		// The rows and order of stats.gateway.ts leaderboardPage (the public
		// board), without the names and stats it also reads.
		async topPlayerIds(board, n) {
			const res = await tx.execute(sql`
				SELECT r.player_id
				FROM matchmaking_ratings r
				JOIN players p ON p.id = r.player_id
				WHERE r.mod_id = ${board.modId} AND r.game_mode = ${board.gameMode} AND r.season = ${board.seasonId}
				  AND r.games_played >= ${PLACEMENT_GAMES}
				ORDER BY ${leaderboardOrder}
				LIMIT ${n}
			`)
			return res.rows.map((row) => (row as { player_id: string }).player_id)
		},

		playersChangedSince(board, since) {
			return tx
				.select({
					playerId: matchmakingRatings.playerId,
					updatedAt: matchmakingRatings.updatedAt,
				})
				.from(matchmakingRatings)
				.where(
					and(
						eq(matchmakingRatings.modId, board.modId),
						eq(matchmakingRatings.gameMode, board.gameMode),
						eq(matchmakingRatings.season, board.seasonId),
						gt(matchmakingRatings.updatedAt, since),
					),
				)
		},
	}
}

/**
 * Runs `read` in one read-only snapshot (REPEATABLE READ): every read sees
 * the board as it was at the first one, whatever commits meanwhile.
 */
export function inBoardSnapshot<T>(
	read: (reads: BoardReads) => Promise<T>,
): Promise<T> {
	return db.transaction((tx) => read(boardReads(tx)), {
		isolationLevel: 'repeatable read',
		accessMode: 'read only',
	})
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
