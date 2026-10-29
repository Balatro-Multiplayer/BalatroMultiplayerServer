import { type NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { type Result, err, ok } from '../../shared/utils/result.js'
import { rankedGameModeOf } from '../nakama/mirror.service.js'
import { seasonBestColumns } from './season-best.js'
import {
	type RatingRecord,
	type ReplayState,
	type SeasonReplayRun,
	reportOf,
} from './season-replay.service.js'

// The owner's apply of a Season replay (the dry run is season-replay.service.ts).
// Order: check no ranked game is running, replay again and compare with the
// dry run the owner saw, save a backup of the old board, clear the Season board
// in Nakama and write the replayed ratings, fix Postgres, then close the
// anti-cheat queue items of the repaired games. Nobody is messaged.

// admin_ratings_set's per-call limit.
const NAKAMA_BATCH = 1000

export interface NakamaLeaderboardRecord {
	ownerId: string
	username: string
	score: number
	subscore: number
	metadata: Record<string, unknown>
}

export interface NakamaBackup {
	// Every rating record of the Season: key is `<modId>:<mode>:<season>`.
	ratings: { userId: string; key: string; value: RatingRecord }[]
	leaderboard: Record<string, NakamaLeaderboardRecord[]>
}

// A matchmaking_matches row the repair changes.
export interface MatchResult {
	matchId: string
	resultPlacements: { playerId: string; place: number; rated?: boolean }[]
}

export interface SeasonBackup {
	season: { id: number; name: string }
	nakama: NakamaBackup
	// matchmaking_ratings rows of the Season, as JSON (dates are ISO text).
	ratings: Record<string, unknown>[]
	matches: MatchResult[]
}

export interface RatingsSetBatch {
	modId: string
	mode: string
	season: number
	entries: { userId: string; name: string; record: RatingRecord | null }[]
}

export type PostgresRatingRow = {
	playerId: string
	modId: string
	gameMode: string
	season: number
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
	seasonBest: number | null
	seasonBestLen: number | null
	seasonBestRev: number[] | null
	seasonBestText: string | null
	lastMatchAt: Date | null
}

export interface ApplyDeps {
	// Started ranked games, from Nakama.
	activeRankedGames(): Promise<Result<number, NakamaRpcError>>
	replay(startedAt: Date): Promise<Result<SeasonReplayRun, NakamaRpcError>>
	backupNakama(season: number): Promise<Result<NakamaBackup, NakamaRpcError>>
	backupPostgresRatings(season: number): Promise<Record<string, unknown>[]>
	// The matches among these runs that have a player left unrated.
	unratedMatches(runIds: string[]): Promise<MatchResult[]>
	saveBackup(season: number, by: string, data: SeasonBackup): Promise<string>
	loadBackup(id: string): Promise<{ season: number; data: SeasonBackup } | null>
	// Empties the Season board in Nakama: ratings and leaderboard records.
	clearNakama(
		season: number,
		boards: string[],
	): Promise<Result<null, NakamaRpcError>>
	writeNakama(batches: RatingsSetBatch[]): Promise<Result<null, NakamaRpcError>>
	playerIdsOf(nakamaUserIds: string[]): Promise<Map<string, string>>
	replacePostgres(
		season: number,
		ratings: PostgresRatingRow[],
		matches: MatchResult[],
	): Promise<void>
	restorePostgres(
		season: number,
		ratings: Record<string, unknown>[],
		matches: MatchResult[],
	): Promise<void>
	dismissAntiCheat(
		runIds: string[],
		note: string,
	): Promise<{ dismissed: number; failed: number }>
}

export type ApplyRefusal =
	| { code: 'active_games'; count: number }
	| { code: 'stale_token' }
	| { code: 'nakama'; reason: NakamaRpcError; backupId?: string }
	| { code: 'failed'; reason: string; backupId: string }
	| { code: 'no_backup' }

export interface ApplyReport {
	backupId: string
	games: number
	players: number
	repairedGames: number
	dismissedItems: number
	// Open items left because someone holds the claim or the close failed.
	itemsLeftOpen: number
}

export const DISMISS_NOTE =
	'Rated by the Season replay: the game was left unrated while it carried this flag.'

// `<modId>:<mode>:<season>`, from the board and season.
const boardKey = (board: string, season: number) => `${board}:${season}`

const splitBoard = (board: string) => {
	const at = board.indexOf(':')
	return { modId: board.slice(0, at), mode: board.slice(at + 1) }
}

// The `<modId>:<mode>` boards in a list of rating keys of one Season.
export function boardsOfKeys(keys: string[], season: number): string[] {
	const suffix = `:${season}`
	return [...new Set(keys.map((k) => k.slice(0, k.length - suffix.length)))]
}

function batchesOf(
	season: number,
	boards: Record<string, RatingsSetBatch['entries']>,
): RatingsSetBatch[] {
	const batches: RatingsSetBatch[] = []
	for (const board of Object.keys(boards).sort()) {
		const { modId, mode } = splitBoard(board)
		const entries = boards[board]
		for (let i = 0; i < entries.length; i += NAKAMA_BATCH)
			batches.push({
				modId,
				mode,
				season,
				entries: entries.slice(i, i + NAKAMA_BATCH),
			})
	}
	return batches
}

// The replayed ratings, as admin_ratings_set takes them.
export function writeBatchesOf(
	state: ReplayState,
	season: number,
): RatingsSetBatch[] {
	const boards: Record<string, RatingsSetBatch['entries']> = {}
	for (const board of Object.keys(state))
		boards[board] = Object.keys(state[board]).map((userId) => ({
			userId,
			name: state[board][userId].name,
			record: state[board][userId].after,
		}))
	return batchesOf(season, boards)
}

// The old board as admin_ratings_set takes it, to put it back. Names come from
// the leaderboard records (a player not on the board has none to show).
export function restoreBatchesOf(
	backup: NakamaBackup,
	season: number,
): RatingsSetBatch[] {
	const boards: Record<string, RatingsSetBatch['entries']> = {}
	for (const r of backup.ratings) {
		const board = r.key.slice(0, r.key.length - `:${season}`.length)
		const owner = (backup.leaderboard[r.key] ?? []).find(
			(l) => l.ownerId === r.userId,
		)
		;(boards[board] ??= []).push({
			userId: r.userId,
			name: owner ? owner.username : '',
			record: r.value,
		})
	}
	return batchesOf(season, boards)
}

// The matchmaking_ratings rows the replay leaves. A player without a Postgres
// account has no row.
export function ratingRowsOf(
	state: ReplayState,
	playerIds: Map<string, string>,
	season: number,
): PostgresRatingRow[] {
	const rows: PostgresRatingRow[] = []
	for (const board of Object.keys(state)) {
		const { modId, mode } = splitBoard(board)
		for (const userId of Object.keys(state[board])) {
			const playerId = playerIds.get(userId)
			if (!playerId) continue
			const after = state[board][userId].after
			rows.push({
				playerId,
				modId,
				gameMode: rankedGameModeOf(mode),
				season,
				rating: Math.round(after.rating),
				wins: after.wins,
				losses: after.losses,
				gamesPlayed: after.gamesPlayed,
				...seasonBestColumns(modId, after.seasonBest),
				lastMatchAt: after.lastMatchAt ? new Date(after.lastMatchAt) : null,
			})
		}
	}
	return rows
}

// The result with every player marked rated, as the replay rated them.
export function ratedResultOf(match: MatchResult): MatchResult {
	return {
		matchId: match.matchId,
		resultPlacements: match.resultPlacements.map((p) =>
			p.rated === false ? { ...p, rated: true } : p,
		),
	}
}

export function createSeasonReplayApply(deps: ApplyDeps) {
	async function apply(
		season: { id: number; name: string; startedAt: Date },
		token: string,
		by: string,
	): Promise<Result<ApplyReport, ApplyRefusal>> {
		const active = await deps.activeRankedGames()
		if (!active.ok) return err({ code: 'nakama', reason: active.error })
		if (active.value > 0)
			return err({ code: 'active_games', count: active.value })

		const replay = await deps.replay(season.startedAt)
		if (!replay.ok) return err({ code: 'nakama', reason: replay.error })
		const { refs, state, games } = replay.value
		// Compared with the report the owner saw; same digest as the dry run.
		if (reportOf(games, state).token !== token)
			return err({ code: 'stale_token' })
		// A game that ended while the replay ran is not in it.
		const after = await deps.activeRankedGames()
		if (!after.ok) return err({ code: 'nakama', reason: after.error })
		if (after.value > 0)
			return err({ code: 'active_games', count: after.value })

		const repaired = (
			await deps.unratedMatches(refs.map((r) => r.runId))
		).filter((m) => m.resultPlacements.length >= 2)
		const nakama = await deps.backupNakama(season.id)
		if (!nakama.ok) return err({ code: 'nakama', reason: nakama.error })
		const backupId = await deps.saveBackup(season.id, by, {
			season: { id: season.id, name: season.name },
			nakama: nakama.value,
			ratings: await deps.backupPostgresRatings(season.id),
			matches: repaired,
		})

		const boards = [
			...new Set([
				...boardsOfKeys(
					nakama.value.ratings.map((r) => r.key),
					season.id,
				),
				...Object.keys(state),
			]),
		].map((b) => boardKey(b, season.id))
		const cleared = await deps.clearNakama(season.id, boards)
		if (!cleared.ok)
			return err({ code: 'nakama', reason: cleared.error, backupId })
		const written = await deps.writeNakama(writeBatchesOf(state, season.id))
		if (!written.ok)
			return err({ code: 'nakama', reason: written.error, backupId })

		const userIds = [
			...new Set(Object.values(state).flatMap((b) => Object.keys(b))),
		]
		try {
			await deps.replacePostgres(
				season.id,
				ratingRowsOf(state, await deps.playerIdsOf(userIds), season.id),
				repaired.map(ratedResultOf),
			)
		} catch (e) {
			return err({ code: 'failed', reason: `Postgres: ${String(e)}`, backupId })
		}
		const closed = await deps.dismissAntiCheat(
			repaired.map((m) => m.matchId),
			DISMISS_NOTE,
		)
		return ok({
			backupId,
			games,
			players: userIds.length,
			repairedGames: repaired.length,
			dismissedItems: closed.dismissed,
			itemsLeftOpen: closed.failed,
		})
	}

	// Puts a backup back: the Nakama board, the Postgres rating rows and the
	// results the apply marked rated. Queue items stay dismissed (reopen them in
	// the queue).
	async function restore(
		backupId: string,
	): Promise<Result<{ season: number }, ApplyRefusal>> {
		const backup = await deps.loadBackup(backupId)
		if (!backup) return err({ code: 'no_backup' })
		const { season, data } = backup
		const boards = [
			...new Set([
				...boardsOfKeys(
					data.nakama.ratings.map((r) => r.key),
					season,
				),
				...Object.keys(data.nakama.leaderboard).map((k) =>
					k.slice(0, k.length - `:${season}`.length),
				),
			]),
		]
		const keys = boards.map((b) => boardKey(b, season))
		const cleared = await deps.clearNakama(season, keys)
		if (!cleared.ok) return err({ code: 'nakama', reason: cleared.error })
		const written = await deps.writeNakama(
			restoreBatchesOf(data.nakama, season),
		)
		if (!written.ok) return err({ code: 'nakama', reason: written.error })
		try {
			await deps.restorePostgres(season, data.ratings, data.matches)
		} catch (e) {
			return err({ code: 'failed', reason: `Postgres: ${String(e)}`, backupId })
		}
		return ok({ season })
	}

	return { apply, restore }
}
