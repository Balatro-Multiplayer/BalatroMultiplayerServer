import { asc, eq, sql } from 'drizzle-orm'
import type {
	BetaBoardQuery,
	BetaGameResult,
	BetaGamesQuery,
	BetaPlayerRef,
	IBetaSeasonsRepository,
} from '../../contracts/IBetaSeasons.js'
import type {
	BetaRow,
	GameRow,
	SeasonRow,
	StandingRow,
} from '../../features/beta-seasons/import-records.js'
import { shownNameOf } from '../../shared/players/shown-name.js'
import { db } from '../db/index.js'
import {
	betaSeasonGames,
	betaSeasonStandings,
	betaSeasons,
	players,
} from '../db/schema.js'
import { usernameBannedSql } from './ban.gateway.js'

// A row's player: the linked live account (alias `p`, may be absent) when
// there is one, else the legacy name.
function playerRefOf(
	r: Record<string, unknown>,
	legacyName: string,
): BetaPlayerRef {
	if (!r.player_id) return { playerId: null, displayName: legacyName }
	return {
		playerId: r.player_id as string,
		displayName: shownNameOf(
			{
				id: r.player_id as string,
				nakamaUserId: (r.nakama_user_id as string | null) ?? null,
				steamName: r.steam_name as string,
				discordUsername: (r.discord_username as string | null) ?? null,
				useDiscordName: Boolean(r.use_discord_name),
			},
			Boolean(r.username_banned),
		),
	}
}

const numOrNull = (v: unknown) =>
	v === null || v === undefined ? null : Number(v)

const linkedPlayerCols = sql`p.id AS player_id, p.steam_name, p.discord_username, p.use_discord_name, p.nakama_user_id,
	(p.id IS NOT NULL AND ${usernameBannedSql}) AS username_banned`

function boardWhere(q: BetaBoardQuery) {
	return sql`s.season = ${q.season} AND s.mod_id = ${q.modId} AND s.game_mode = ${q.gameMode}
		${q.term ? sql`AND (s.name ILIKE ${q.term} OR (p.id IS NOT NULL AND NOT ${usernameBannedSql} AND (p.steam_name ILIKE ${q.term} OR p.discord_username ILIKE ${q.term})))` : sql``}`
}

const joinLinkedPlayer = sql`LEFT JOIN players p ON p.discord_id_hash = s.discord_id_hash AND p.deleted_at IS NULL`

export const betaSeasonsRepository: IBetaSeasonsRepository = {
	async listSeasons() {
		const [seasonRows, boardRes] = await Promise.all([
			db.select().from(betaSeasons).orderBy(asc(betaSeasons.number)),
			db.execute(sql`
				SELECT season, mod_id, game_mode, count(*)::int AS entries
				FROM beta_season_standings
				GROUP BY season, mod_id, game_mode
				ORDER BY season, entries DESC
			`),
		])
		const boards = boardRes.rows as {
			season: number
			mod_id: string
			game_mode: string
			entries: number
		}[]
		return seasonRows.map((s) => ({
			number: s.number,
			name: s.name,
			startedAt: s.startedAt,
			endedAt: s.endedAt,
			boards: boards
				.filter((b) => Number(b.season) === s.number)
				.map((b) => ({
					modId: b.mod_id,
					gameMode: b.game_mode,
					entries: Number(b.entries),
				})),
		}))
	},

	async countBoard(q) {
		const res = await db.execute(sql`
			SELECT count(*)::int AS total
			FROM beta_season_standings s ${joinLinkedPlayer}
			WHERE ${boardWhere(q)}
		`)
		return Number((res.rows[0] as { total: number } | undefined)?.total ?? 0)
	},

	// Rank is the final place the season ended with, so a search keeps it.
	async boardPage(q, pageSize, offset) {
		const res = await db.execute(sql`
			SELECT s.rank, s.name, s.rating, s.peak_rating, s.wins, s.losses, s.games_played, ${linkedPlayerCols}
			FROM beta_season_standings s ${joinLinkedPlayer}
			WHERE ${boardWhere(q)}
			ORDER BY s.rank, s.discord_id_hash
			LIMIT ${pageSize} OFFSET ${offset}
		`)
		return res.rows.map((row) => {
			const r = row as Record<string, unknown>
			return {
				...playerRefOf(r, r.name as string),
				rank: Number(r.rank),
				rating: Number(r.rating),
				peakRating: numOrNull(r.peak_rating),
				wins: Number(r.wins),
				losses: Number(r.losses),
				gamesPlayed: Number(r.games_played),
			}
		})
	},

	async discordHashOf(playerId) {
		const [row] = await db
			.select({ hash: players.discordIdHash, deletedAt: players.deletedAt })
			.from(players)
			.where(eq(players.id, playerId))
			.limit(1)
		return row && !row.deletedAt ? (row.hash ?? null) : null
	},

	async standingsOf(discordIdHash) {
		const res = await db.execute(sql`
			SELECT s.season, bs.name AS season_name, s.mod_id, s.game_mode, s.rank, s.rating, s.peak_rating,
			       s.wins, s.losses, s.games_played,
			       (SELECT count(*)::int FROM beta_season_standings b
			        WHERE b.season = s.season AND b.mod_id = s.mod_id AND b.game_mode = s.game_mode) AS board_size
			FROM beta_season_standings s
			JOIN beta_seasons bs ON bs.number = s.season
			WHERE s.discord_id_hash = ${discordIdHash}
			ORDER BY s.season DESC, s.games_played DESC
		`)
		return res.rows.map((row) => {
			const r = row as Record<string, unknown>
			return {
				season: Number(r.season),
				seasonName: r.season_name as string,
				modId: r.mod_id as string,
				gameMode: r.game_mode as string,
				rank: Number(r.rank),
				boardSize: Number(r.board_size),
				rating: Number(r.rating),
				peakRating: numOrNull(r.peak_rating),
				wins: Number(r.wins),
				losses: Number(r.losses),
				gamesPlayed: Number(r.games_played),
			}
		})
	},

	async countGames(q) {
		const res = await db.execute(sql`
			SELECT count(*)::int AS total FROM beta_season_games
			WHERE discord_id_hash = ${q.discordIdHash} AND season = ${q.season}
			  AND mod_id = ${q.modId} AND game_mode = ${q.gameMode}
		`)
		return Number((res.rows[0] as { total: number } | undefined)?.total ?? 0)
	},

	// Newest first. The opponent links to their account the same way.
	async gamesPage(q: BetaGamesQuery, pageSize, offset) {
		const res = await db.execute(sql`
			SELECT g.played_at, g.result, g.rating_after, g.rating_change, g.deck, g.stake,
			       g.opponent_id_hash, g.opponent_name, ${linkedPlayerCols}
			FROM beta_season_games g
			LEFT JOIN players p ON g.opponent_id_hash IS NOT NULL
			     AND p.discord_id_hash = g.opponent_id_hash AND p.deleted_at IS NULL
			WHERE g.discord_id_hash = ${q.discordIdHash} AND g.season = ${q.season}
			  AND g.mod_id = ${q.modId} AND g.game_mode = ${q.gameMode}
			ORDER BY g.played_at DESC, g.match_key DESC
			LIMIT ${pageSize} OFFSET ${offset}
		`)
		return res.rows.map((row) => {
			const r = row as Record<string, unknown>
			const hasOpponent =
				r.opponent_id_hash !== null || r.opponent_name !== null
			return {
				playedAt: new Date(r.played_at as string),
				result: r.result as BetaGameResult,
				ratingAfter: numOrNull(r.rating_after),
				ratingChange: numOrNull(r.rating_change),
				deck: (r.deck as string | null) ?? null,
				stake: (r.stake as string | null) ?? null,
				opponent: hasOpponent
					? playerRefOf(r, (r.opponent_name as string | null) ?? 'Unknown')
					: null,
			}
		})
	},
}

const INSERT_BATCH = 2000

// The import's one write: every Beta Season table replaced in one transaction,
// so a second run gives the same tables and a failed run changes nothing.
// Rows stream in, so the whole file is never held in memory.
export async function replaceBetaSeasons(
	rows: AsyncIterable<BetaRow>,
): Promise<{ seasons: number; standings: number; games: number }> {
	const counts = { seasons: 0, standings: 0, games: 0 }
	await db.transaction(async (tx) => {
		await tx.delete(betaSeasonGames)
		await tx.delete(betaSeasonStandings)
		await tx.delete(betaSeasons)
		let seasons: SeasonRow[] = []
		let standings: StandingRow[] = []
		let games: GameRow[] = []
		const flush = async () => {
			if (seasons.length) await tx.insert(betaSeasons).values(seasons)
			if (standings.length)
				await tx.insert(betaSeasonStandings).values(standings)
			if (games.length) await tx.insert(betaSeasonGames).values(games)
			counts.seasons += seasons.length
			counts.standings += standings.length
			counts.games += games.length
			seasons = []
			standings = []
			games = []
		}
		for await (const r of rows) {
			if (r.table === 'season') seasons.push(r.row)
			else if (r.table === 'standing') standings.push(r.row)
			else games.push(r.row)
			if (seasons.length + standings.length + games.length >= INSERT_BATCH)
				await flush()
		}
		await flush()
	})
	return counts
}
