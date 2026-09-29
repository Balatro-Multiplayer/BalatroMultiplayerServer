// Rates a finished ranked game. planRatings is pure; applyRatings reads and
// writes Nakama storage around it (and mirrors ratings into a leaderboard).
import {
	computeRatingDeltas,
	detectRatingMode,
	INITIAL_HIDDEN_RATING,
	PLACEMENT_GAMES,
	RATING_FLOOR,
} from './elo'
import { nextSeasonBest } from './metrics'
import type { LogCheck, RunRecord } from '../lobby/protocol'
import { RATINGS_COLLECTION, type RatingResult } from '../lobby/protocol'

// One rating season for now; rollover and decay aren't ported yet.
export const CURRENT_SEASON = 1

// A player's rating on one (mod, mode, season) board: the stored object.
export interface RatingRecord {
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
	seasonBest: number | null
	lastMatchAt: number
}

export function boardId(modId: string, mode: string): string {
	return `${modId}:${mode}:${CURRENT_SEASON}`
}

export function newRating(): RatingRecord {
	return {
		rating: INITIAL_HIDDEN_RATING,
		wins: 0,
		losses: 0,
		gamesPlayed: 0,
		seasonBest: null,
		lastMatchAt: 0,
	}
}

export interface RatingPlan {
	updates: { [userId: string]: RatingRecord }
	results: { [userId: string]: RatingResult }
}

// Who is rated: an agreed or partial result (a disputed one isn't trusted),
// leaving out players whose replay log doesn't match its hash. Fewer than two
// players left rates nobody.
export function planRatings(
	run: RunRecord,
	checks: { [userId: string]: LogCheck },
	current: { [userId: string]: RatingRecord | undefined },
): RatingPlan {
	const plan: RatingPlan = { updates: {}, results: {} }
	if (run.status !== 'agreed' && run.status !== 'partial') return plan
	const placements = run.placements.filter((p) => checks[p.playerId] !== 'mismatch')
	if (placements.length < 2) return plan

	const ratings = new Map<string, RatingRecord>()
	for (const p of placements) ratings.set(p.playerId, current[p.playerId] || newRating())
	const entries = placements.map((p) => ({
		playerId: p.playerId,
		place: p.place,
		performance: p.performance,
	}))
	const deltas = computeRatingDeltas(detectRatingMode(entries), entries, ratings)
	const bestPlace = Math.min(...placements.map((p) => p.place))
	for (const p of placements) {
		const before = ratings.get(p.playerId) as RatingRecord
		const delta = deltas.get(p.playerId) || 0
		const won = p.place === bestPlace
		const after: RatingRecord = {
			rating: Math.max(RATING_FLOOR, before.rating + delta),
			wins: before.wins + (won ? 1 : 0),
			losses: before.losses + (won ? 0 : 1),
			gamesPlayed: before.gamesPlayed + 1,
			seasonBest: nextSeasonBest(run.modId, p.metric, before.seasonBest),
			lastMatchAt: run.endedAt,
		}
		plan.updates[p.playerId] = after
		// A player still in their placement games isn't shown their rating.
		const placing = after.gamesPlayed < PLACEMENT_GAMES
		plan.results[p.playerId] = {
			delta: placing ? null : after.rating - before.rating,
			newRating: placing ? null : after.rating,
			isPlacement: placing,
			gamesPlayed: after.gamesPlayed,
		}
	}
	return plan
}

// Pending optimistic-lock retries: ratings are shared by every match, so two
// games ending together can race on the same player's object.
const WRITE_ATTEMPTS = 5

function keyOf(modId: string, mode: string): string {
	return boardId(modId, mode)
}

// Reads, plans and writes the ratings for a finished ranked game, retrying
// when another game wrote a player's rating in between. Returns each rated
// player's result, or {} if nobody was rated.
export function applyRatings(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	run: RunRecord,
	mode: string,
	checks: { [userId: string]: LogCheck },
): { [userId: string]: RatingResult } {
	const key = keyOf(run.modId, mode)
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const objects = nk.storageRead(
			run.players.map((p) => ({ collection: RATINGS_COLLECTION, key, userId: p.id })),
		)
		const current: { [userId: string]: RatingRecord } = {}
		const versions: { [userId: string]: string | undefined } = {}
		for (const object of objects) {
			current[object.userId] = object.value as unknown as RatingRecord
			versions[object.userId] = object.version
		}
		const plan = planRatings(run, checks, current)
		const ids = Object.keys(plan.updates)
		if (ids.length === 0) return {}
		try {
			nk.storageWrite(
				ids.map((id) => ({
					collection: RATINGS_COLLECTION,
					key,
					userId: id,
					value: plan.updates[id] as unknown as { [key: string]: unknown },
					permissionRead: 2,
					permissionWrite: 0,
					// '*' = only if it doesn't exist yet.
					version: versions[id] || '*',
				})),
			)
		} catch (e) {
			logger.warn('Rating write for run %s conflicted (attempt %d): %v', run.runId, attempt + 1, e)
			continue
		}
		mirrorToLeaderboard(nk, logger, run, mode, plan, checks)
		return plan.results
	}
	logger.error('Could not rate run %s after %d attempts', run.runId, WRITE_ATTEMPTS)
	return {}
}

// Players with their placement games behind them go on the board (the legacy
// leaderboard also hides everyone under 5 games).
function mirrorToLeaderboard(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	run: RunRecord,
	mode: string,
	plan: RatingPlan,
	_checks: { [userId: string]: LogCheck },
) {
	const id = boardId(run.modId, mode)
	try {
		nk.leaderboardCreate(id, true, 'desc', 'set', null, { modId: run.modId, mode })
		for (const player of run.players) {
			const after = plan.updates[player.id]
			if (!after || after.gamesPlayed < PLACEMENT_GAMES) continue
			nk.leaderboardRecordWrite(id, player.id, player.displayName, after.rating, after.wins, {
				losses: after.losses,
				gamesPlayed: after.gamesPlayed,
				seasonBest: after.seasonBest,
			}, 'set')
		}
	} catch (e) {
		logger.warn('Leaderboard update for run %s failed: %v', run.runId, e)
	}
}
