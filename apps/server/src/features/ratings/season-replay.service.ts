import { createHash } from 'node:crypto'
import {
	type NakamaRpcError,
	callNakamaRpc,
} from '../../infrastructure/nakama/admin-client.js'
import { type Result, ok } from '../../shared/utils/result.js'

// The owner's dry run of a Season replay. Nakama replays the stored ranked
// games (nakama/src/rating/replay.ts) and writes nothing. Runtime state does
// not survive between its calls, so the API lists the runs page by page, sorts
// them by end time, then feeds them back in small batches with the state so
// far.

export interface RatingRecord {
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
	seasonBest: number | null
	lastMatchAt: number
}

export interface ReplayEntry {
	name: string
	before: RatingRecord | null
	after: RatingRecord
}

export type ReplayState = Record<string, Record<string, ReplayEntry>>

export interface RunRef {
	runId: string
	endedAt: number
}

export interface ReplayPlayer {
	userId: string
	name: string
	modId: string
	mode: string
	before: RatingRecord | null
	after: RatingRecord
}

export interface SeasonReplayReport {
	games: number
	changedPlayers: number
	players: ReplayPlayer[]
	// A digest of the games and of each player's rating before and after. The
	// owner sends it back to apply: it only matches while a fresh replay gives
	// the same numbers, so a board that changed since (an apply included) no
	// longer matches.
	token: string
}

export type SeasonReplayError = NakamaRpcError | 'no_season'

export type ReplayCall = <T>(
	id: string,
	body: Record<string, unknown>,
) => Promise<Result<T, NakamaRpcError>>

// Runs per fold call: each one reads its runs and the players' stored ratings.
const FOLD_BATCH = 100
// A list call scans up to 1000 stored runs; a fold call reads a batch.
const CALL_TIMEOUT_MS = 60_000

export const callNakama: ReplayCall = (id, body) =>
	callNakamaRpc(id, body, { timeoutMs: CALL_TIMEOUT_MS })

const byEndThenId = (a: RunRef, b: RunRef) =>
	a.endedAt - b.endedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)

// Pure: a player counts as changed when the replay ends on another rating
// than the one stored now (or nothing is stored).
export function reportOf(games: number, state: ReplayState): SeasonReplayReport {
	const players: ReplayPlayer[] = []
	for (const board of Object.keys(state).sort()) {
		const split = board.indexOf(':')
		for (const userId of Object.keys(state[board]).sort()) {
			const entry = state[board][userId]
			players.push({
				userId,
				name: entry.name,
				modId: board.slice(0, split),
				mode: board.slice(split + 1),
				before: entry.before,
				after: entry.after,
			})
		}
	}
	const changedPlayers = players.filter(
		(p) => p.before === null || p.before.rating !== p.after.rating,
	).length
	return { games, changedPlayers, players, token: tokenOf(games, players) }
}

// Nakama returns a stored record's keys in no fixed order, and a field can be
// null or absent for the same data. The digest sorts keys and drops both.
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((v) => canonical(v) ?? null)
	if (value === null || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(value).sort()) {
		const v = (value as Record<string, unknown>)[key]
		if (v !== null && v !== undefined) out[key] = canonical(v)
	}
	return out
}

function tokenOf(games: number, players: ReplayPlayer[]): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				games,
				players.map((p) => canonical([p.userId, p.modId, p.mode, p.before, p.after])),
			]),
		)
		.digest('hex')
}

// The replay's runs in order, the state it ended on and how many games it rated.
export interface SeasonReplayRun {
	refs: RunRef[]
	state: ReplayState
	games: number
}

export async function replayRuns(
	startedAt: Date,
	call: ReplayCall = callNakama,
): Promise<Result<SeasonReplayRun, NakamaRpcError>> {
	const refs: RunRef[] = []
	let cursor = ''
	do {
		const page = await call<{ runs: RunRef[]; cursor: string }>(
			'admin_ratings_replay_list',
			{ startedAt: startedAt.getTime(), cursor },
		)
		if (!page.ok) return page
		refs.push(...page.value.runs)
		cursor = page.value.cursor
	} while (cursor !== '')
	refs.sort(byEndThenId)

	let state: ReplayState = {}
	let games = 0
	for (let i = 0; i < refs.length; i += FOLD_BATCH) {
		const batch = await call<{ state: ReplayState; rated: number }>(
			'admin_ratings_replay_fold',
			{ runIds: refs.slice(i, i + FOLD_BATCH).map((r) => r.runId), state },
		)
		if (!batch.ok) return batch
		state = batch.value.state
		games += batch.value.rated
	}
	return ok({ refs, state, games })
}

export async function replaySeason(
	startedAt: Date,
	call: ReplayCall = callNakama,
): Promise<Result<SeasonReplayReport, NakamaRpcError>> {
	const run = await replayRuns(startedAt, call)
	if (!run.ok) return run
	return ok(reportOf(run.value.games, run.value.state))
}
