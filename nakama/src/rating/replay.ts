// Admin RPCs that replay a season's ranked games through the live rating code
// without writing anything: the owner's dry run. Runtime state does not
// survive between calls, so the API drives two RPCs. The list RPC pages the
// stored runs and returns the ones to replay (the API sorts them by end time).
// The fold RPC takes a batch of run ids in that order plus the state so far
// and returns the state after them.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import {
	type LogCheck,
	LOGS_COLLECTION,
	RATINGS_COLLECTION,
	RUNS_COLLECTION,
	type RunRecord,
	SYSTEM_USER_ID,
} from '../lobby/protocol'
import { logKey } from '../lobby/storage'
import { parsePayload, requireServer } from '../rpc'
import { eventsOfStored, type LogEvent } from '../shared/replay/events'
import { boardId, newRating, planRatings, type RatingRecord } from './apply'
import { logBounds } from './metrics'
import { carriedOver, currentSeason, decayedRating } from './season'

const LIST_PAGE = 100
// Storage pages scanned per list call.
const LIST_PAGES_PER_CALL = 10
export const FOLD_MAX_RUNS = 100

// One player on one (mod, mode) board: the stored rating before the replay
// (null = nothing stored this season) and the rating the replay ended on.
export interface ReplayEntry {
	name: string
	before: RatingRecord | null
	after: RatingRecord
}

// Keyed by `<modId>:<mode>`, then by user id.
export interface ReplayState {
	[board: string]: { [userId: string]: ReplayEntry }
}

export interface ReplayRunRef {
	runId: string
	endedAt: number
}

// The same games applyRatings rates: ranked, and agreed or partial.
export function isReplayable(run: RunRecord, startedAt: number): boolean {
	return (
		!!run.rankedMode &&
		(run.status === 'agreed' || run.status === 'partial') &&
		run.endedAt >= startedAt
	)
}

function listRuns(
	nk: nkruntime.Nakama,
	startedAt: number,
	cursor: string,
): { runs: ReplayRunRef[]; cursor: string } {
	const runs: ReplayRunRef[] = []
	let next = cursor
	for (let pages = 0; pages < LIST_PAGES_PER_CALL; pages++) {
		const page = nk.storageList(
			SYSTEM_USER_ID,
			RUNS_COLLECTION,
			LIST_PAGE,
			next,
		)
		for (const o of page.objects || []) {
			const run = o.value as unknown as RunRecord
			if (isReplayable(run, startedAt))
				runs.push({ runId: run.runId, endedAt: run.endedAt })
		}
		next = page.cursor || ''
		if (next === '') break
	}
	return { runs, cursor: next }
}

// Players new to `board` in the state: their stored rating now (the "before")
// and what the live code would seed them with, carried over from last season.
function seedsFor(
	nk: nkruntime.Nakama,
	run: RunRecord,
	mode: string,
	season: number,
	unseen: string[],
): {
	[userId: string]: {
		before: RatingRecord | null
		seed: RatingRecord | undefined
	}
} {
	const out: {
		[userId: string]: {
			before: RatingRecord | null
			seed: RatingRecord | undefined
		}
	} = {}
	for (const id of unseen) out[id] = { before: null, seed: undefined }
	const read = (key: string) =>
		nk.storageRead(
			unseen.map((id) => ({ collection: RATINGS_COLLECTION, key, userId: id })),
		)
	for (const o of read(boardId(run.modId, mode, season)))
		out[o.userId].before = o.value as unknown as RatingRecord
	if (season > 1) {
		for (const o of read(boardId(run.modId, mode, season - 1))) {
			const rating = carriedOver(
				o.value as unknown as RatingRecord,
				run.endedAt,
			)
			if (rating !== undefined) out[o.userId].seed = { ...newRating(), rating }
		}
	}
	return out
}

// Each player's season best bound, as the live game set it (lobby/match.ts),
// from the stored logs and the check each was stored with. A log retention
// deleted bounds nothing, so its claim counts. Logs are large, so a game with
// no claimed score (a time board) reads none.
function storedBounds(
	nk: nkruntime.Nakama,
	run: RunRecord,
): { [userId: string]: string } {
	if (!run.placements.some((p) => p.metricText !== undefined)) return {}
	const events: { [userId: string]: LogEvent[] } = {}
	const checks: { [userId: string]: LogCheck } = {}
	for (const o of nk.storageRead(
		run.players.map((p) => ({
			collection: LOGS_COLLECTION,
			key: logKey(run.runId, p.id),
			userId: SYSTEM_USER_ID,
		})),
	)) {
		const id = o.key.slice(run.runId.length + 1)
		events[id] = eventsOfStored(o.value)
		checks[id] = (o.value as { check?: LogCheck }).check || 'unavailable'
	}
	return logBounds(events, checks)
}

function nameOf(run: RunRecord, userId: string): string {
	const player = run.players.find((p) => p.id === userId)
	return player ? player.displayName : ''
}

// Pure but for the reads: the state after `run`, as loadRatings and
// planRatings would have left the ratings.
function foldRun(
	nk: nkruntime.Nakama,
	run: RunRecord,
	state: ReplayState,
	season: number,
): ReplayState {
	const mode = run.rankedMode as string
	const board = `${run.modId}:${mode}`
	const known = state[board] || {}
	const ids = run.players.map((p) => p.id)
	const seeds = seedsFor(
		nk,
		run,
		mode,
		season,
		ids.filter((id) => !known[id]),
	)
	const current: { [userId: string]: RatingRecord | undefined } = {}
	for (const id of ids) {
		const entry = known[id]
		if (entry)
			current[id] = {
				...entry.after,
				rating: decayedRating(entry.after, run.endedAt),
			}
		else current[id] = seeds[id].seed
	}
	const updates = planRatings(run, current, storedBounds(nk, run)).updates
	const next = { ...known }
	for (const id of Object.keys(updates)) {
		next[id] = {
			name: nameOf(run, id),
			before: known[id] ? known[id].before : seeds[id].before,
			after: updates[id],
		}
	}
	return { ...state, [board]: next }
}

// {startedAt, cursor} -> {runs: [{runId, endedAt}], cursor}. `startedAt` is the
// season's start (the API's seasons table; Nakama only knows the number).
// Call again with the returned cursor until it is ''.
export function rpcAdminRatingsReplayList(
	ctx: nkruntime.Context,
	_logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const { startedAt, cursor } = parsePayload(payload)
	if (typeof startedAt !== 'number' || !Number.isFinite(startedAt))
		throw runtimeError(INVALID_ARGUMENT, 'startedAt is required')
	if (cursor !== undefined && typeof cursor !== 'string')
		throw runtimeError(INVALID_ARGUMENT, 'cursor must be a string')
	try {
		return JSON.stringify(
			listRuns(nk, startedAt, (cursor as string | undefined) || ''),
		)
	} catch (e) {
		if (cursor) throw runtimeError(INVALID_ARGUMENT, 'Invalid cursor')
		throw e
	}
}

// {runIds, state} -> {state, rated}. Replays the named runs, in the order
// given, from `state` ({} to start). A run that is gone or not replayable is
// skipped. Writes nothing.
export function rpcAdminRatingsReplayFold(
	ctx: nkruntime.Context,
	_logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const { runIds, state } = parsePayload(payload)
	if (
		!Array.isArray(runIds) ||
		runIds.length > FOLD_MAX_RUNS ||
		runIds.some((id) => typeof id !== 'string')
	)
		throw runtimeError(
			INVALID_ARGUMENT,
			`runIds must be a list of at most ${FOLD_MAX_RUNS} ids`,
		)
	if (
		state !== undefined &&
		(typeof state !== 'object' || state === null || Array.isArray(state))
	)
		throw runtimeError(INVALID_ARGUMENT, 'state must be an object')
	const season = currentSeason(nk)
	const stored: { [runId: string]: RunRecord } = {}
	for (const o of nk.storageRead(
		(runIds as string[]).map((key) => ({
			collection: RUNS_COLLECTION,
			key,
			userId: SYSTEM_USER_ID,
		})),
	))
		stored[o.key] = o.value as unknown as RunRecord
	let folded = (state || {}) as ReplayState
	let rated = 0
	for (const id of runIds as string[]) {
		const run = stored[id]
		if (!run || !isReplayable(run, 0)) continue
		folded = foldRun(nk, run, folded, season)
		rated++
	}
	return JSON.stringify({ state: folded, rated })
}
