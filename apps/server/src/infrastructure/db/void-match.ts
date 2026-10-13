/**
 * Void a single already-resolved ranked match's rating effect, without
 * assuming a "correct" winner exists to restore -- for cases like a wrongful
 * auto-forfeit (a player Nakama forfeited for a disconnect who then came back), where the
 * match record itself may still be worth keeping as a historical artifact
 * but its impact on ratings/leaderboard needs to be undone.
 *
 * Rating reversal is not cheaply invertible in general: matchmaking_ratings
 * stores only a single mutable current row per (player, mod, gameMode,
 * season) -- no per-match delta or pre-match snapshot survives
 * applyRatingTransaction's in-place update, and later matches for the same
 * players compound on top of it (both through rating and gamesPlayed, which
 * gates the placement-window K-factor). So this reconstructs the correct
 * state the same way the whole board would be built from scratch: wipe every
 * rating/leaderboard row in this match's (modId, gameMode, season) scope,
 * mark the target match 'voided' (excluding it from replay), then replay
 * every remaining resolved match in that scope through the real
 * applyRatingTransaction, in original resultReportedAt order -- the same
 * Elo rules, just run standalone.
 *
 * Nakama owns live ratings, so the rebuilt scope is then written over
 * Nakama's copy of the board (admin_ratings_set). The replay uses the
 * Express copy of the Elo rules (features/ratings/elo.ts), which can differ
 * slightly from Nakama's own rating of the same games.
 *
 * Run with:
 *   tsx --env-file=.env src/infrastructure/db/void-match.ts <matchId>
 */

import { and, asc, eq, gt, gte, isNull, lte, or } from 'drizzle-orm'
import type { PlacementEntry } from '../../shared/types/index.js'
import {
	applyRatingTransaction,
	listScopeRatings,
} from '../gateways/rating.gateway.js'
import { callNakamaRpc } from '../nakama/admin-client.js'
import { db, pool } from './index.js'
import {
	leaderboardCache,
	matchmakingMatches,
	matchmakingRatings,
	seasons,
} from './schema.js'

// admin_ratings_set's per-call limit.
const RATINGS_SET_BATCH = 1000

type ScopeRating = Awaited<ReturnType<typeof listScopeRatings>>[number]

// Nakama keys boards by the bare mode ('ranked:' dropped).
export function nakamaModeOf(gameMode: string): string {
	return gameMode.replace(/^ranked:/, '')
}

// What admin_ratings_set should hold for the scope: every rebuilt rating,
// and a clear for each player who was rated before the void but no longer
// is. Players without a Nakama account have no Nakama board to fix.
export function nakamaRatingEntries(
	before: ScopeRating[],
	after: ScopeRating[],
) {
	const rated = new Set(after.map((r) => r.playerId))
	const entries: {
		userId: string
		name: string
		record: Record<string, unknown> | null
	}[] = []
	for (const r of after) {
		if (!r.nakamaUserId) continue
		entries.push({
			userId: r.nakamaUserId,
			name: r.displayName,
			record: {
				rating: r.rating,
				wins: r.wins,
				losses: r.losses,
				gamesPlayed: r.gamesPlayed,
				seasonBest: r.seasonBest,
				lastMatchAt: r.lastMatchAt ? r.lastMatchAt.getTime() : 0,
			},
		})
	}
	for (const r of before) {
		if (r.nakamaUserId && !rated.has(r.playerId))
			entries.push({ userId: r.nakamaUserId, name: '', record: null })
	}
	return entries
}

export async function voidMatch(matchId: string): Promise<void> {
	const [match] = await db
		.select()
		.from(matchmakingMatches)
		.where(eq(matchmakingMatches.matchId, matchId))

	if (!match) throw new Error(`match ${matchId} not found`)

	if (match.status === 'voided') {
		console.log(`[void-match] ${matchId} is already voided -- nothing to do`)
		return
	}
	if (match.status !== 'resolved') {
		console.log(
			`[void-match] ${matchId} has status='${match.status}', not 'resolved' -- refusing to void`,
		)
		return
	}
	if (!match.resultReportedAt) {
		throw new Error(
			`match ${matchId} has no resultReportedAt -- cannot resolve its season`,
		)
	}

	// The season *active when this match resolved*, not necessarily today's
	// current season -- a void of an old match must not touch the live board.
	const [season] = await db
		.select()
		.from(seasons)
		.where(
			and(
				lte(seasons.startedAt, match.resultReportedAt),
				or(
					isNull(seasons.endedAt),
					gt(seasons.endedAt, match.resultReportedAt),
				),
			),
		)
		.orderBy(asc(seasons.startedAt))
		.limit(1)

	if (!season)
		throw new Error(
			`could not resolve the season active at ${match.resultReportedAt.toISOString()}`,
		)

	const { modId, gameMode } = match
	console.log(
		`[void-match] voiding ${matchId} (${modId}:${gameMode}, season ${season.id} "${season.name}")`,
	)

	const before = await listScopeRatings(modId, gameMode, season.id)

	await db
		.update(matchmakingMatches)
		.set({ status: 'voided' })
		.where(eq(matchmakingMatches.matchId, matchId))

	const delRatings = await db
		.delete(matchmakingRatings)
		.where(
			and(
				eq(matchmakingRatings.modId, modId),
				eq(matchmakingRatings.gameMode, gameMode),
				eq(matchmakingRatings.season, season.id),
			),
		)
	const delBoard = await db
		.delete(leaderboardCache)
		.where(
			and(
				eq(leaderboardCache.modId, modId),
				eq(leaderboardCache.gameMode, gameMode),
				eq(leaderboardCache.season, season.id),
			),
		)
	console.log(
		`[void-match] cleared scope (${modId}:${gameMode}, season ${season.id}): ratings=${delRatings.rowCount} leaderboard=${delBoard.rowCount}`,
	)

	const scopedMatches = await db
		.select()
		.from(matchmakingMatches)
		.where(
			and(
				eq(matchmakingMatches.status, 'resolved'),
				eq(matchmakingMatches.modId, modId),
				eq(matchmakingMatches.gameMode, gameMode),
				gte(matchmakingMatches.createdAt, season.startedAt),
			),
		)
		.orderBy(asc(matchmakingMatches.resultReportedAt))

	console.log(
		`[void-match] replaying ${scopedMatches.length} remaining resolved matches in scope`,
	)

	let n = 0
	for (const row of scopedMatches) {
		if (!row.resultPlacements) continue
		const placements = row.resultPlacements as PlacementEntry[]
		const at = row.resultReportedAt ?? row.updatedAt
		const results = await applyRatingTransaction(row, season.id, placements, at)
		console.log(
			`[void-match]   ${row.matchId}: ${results.map((r) => `${r.playerId}=${r.newRating ?? '(placement)'}`).join(', ')}`,
		)
		n++
	}

	console.log(`[void-match] done -- replayed ${n} matches, ${matchId} excluded`)

	const entries = nakamaRatingEntries(
		before,
		await listScopeRatings(modId, gameMode, season.id),
	)
	for (let i = 0; i < entries.length; i += RATINGS_SET_BATCH) {
		const result = await callNakamaRpc('admin_ratings_set', {
			modId,
			mode: nakamaModeOf(gameMode),
			season: season.id,
			entries: entries.slice(i, i + RATINGS_SET_BATCH),
		})
		if (!result.ok)
			throw new Error(
				`[void-match] pushing the rebuilt ratings to Nakama failed: ${result.error}`,
			)
	}
	console.log(`[void-match] pushed ${entries.length} ratings to Nakama`)
}

async function main() {
	const matchId = process.argv[2]
	if (!matchId) throw new Error('usage: void-match.ts <matchId>')
	await voidMatch(matchId)
	await pool.end()
	process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
