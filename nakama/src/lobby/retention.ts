// Run retention: a finished game's record, logs and player pointers are kept
// for RUN_RETENTION_DAYS, then deleted, but only when the API says so: a
// report or ban can use any run, and only the API knows which. Its hourly job
// lists the old runs with admin_runs_expired, keeps those a report or ban
// still uses (the evidence rule) and deletes the rest with
// admin_runs_purge_named. Flagged or disputed runs are not listed: the API's
// evidence sweep names them once past their limit.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { parsePayload, requireServer } from '../rpc'
import { LOGS_COLLECTION, MY_RUNS_COLLECTION, RUNS_COLLECTION, type RunRecord, SYSTEM_USER_ID } from './protocol'
import { logKey, myRunKey } from './storage'

export const RUN_RETENTION_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000
const LIST_PAGE = 100
// Runs listed per admin_runs_expired call (at least; it ends a storage page).
export const EXPIRED_MAX = 100

export function isKept(run: RunRecord): boolean {
	return Object.keys(run.flags || {}).length > 0 || run.status === 'disputed'
}

export function isPurgeable(run: RunRecord, cutoff: number): boolean {
	return run.endedAt < cutoff && !isKept(run)
}

// Every object a run left in storage. Pure.
export function runObjects(run: RunRecord): nkruntime.StorageReadRequest[] {
	const objects: nkruntime.StorageReadRequest[] = [
		{ collection: RUNS_COLLECTION, key: run.runId, userId: SYSTEM_USER_ID },
	]
	for (const player of run.players) {
		objects.push({ collection: LOGS_COLLECTION, key: logKey(run.runId, player.id), userId: SYSTEM_USER_ID })
		objects.push({ collection: MY_RUNS_COLLECTION, key: myRunKey(run), userId: player.id })
	}
	return objects
}

export interface ExpiredRun {
	runId: string
	endedAt: number
}

// The purgeable runs that ended before `cutoff`, read from `cursor` on. Stops
// after the storage page that reaches `max` runs; `cursor` is where to go on
// from, or '' at the end. Deletes nothing.
export function expiredRuns(
	nk: nkruntime.Nakama,
	cutoff: number,
	max: number,
	cursor: string,
): { runs: ExpiredRun[]; cursor: string } {
	const runs: ExpiredRun[] = []
	let next = cursor
	do {
		const page = nk.storageList(SYSTEM_USER_ID, RUNS_COLLECTION, LIST_PAGE, next)
		for (const o of page.objects || []) {
			const run = o.value as unknown as RunRecord
			if (isPurgeable(run, cutoff)) runs.push({ runId: run.runId, endedAt: run.endedAt })
		}
		next = page.cursor || ''
	} while (next && runs.length < max)
	return { runs, cursor: next }
}

// Run ids per admin_runs_purge_named call at most.
export const PURGE_NAMED_MAX = 100

// Deletes the named runs whatever they hold: the API decided they are past
// their limit. An id with no run is skipped.
export function purgeNamedRuns(nk: nkruntime.Nakama, runIds: string[]): { deleted: number } {
	if (runIds.length === 0) return { deleted: 0 }
	const found = nk.storageRead(runIds.map((key) => ({ collection: RUNS_COLLECTION, key, userId: SYSTEM_USER_ID })))
	for (const o of found) nk.storageDelete(runObjects(o.value as unknown as RunRecord))
	return { deleted: found.length }
}

// {runIds} -> {deleted}.
export function rpcAdminRunsPurgeNamed(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const runIds = parsePayload(payload).runIds
	if (
		!Array.isArray(runIds) ||
		runIds.length > PURGE_NAMED_MAX ||
		!runIds.every((id) => typeof id === 'string' && id.length > 0)
	)
		throw runtimeError(INVALID_ARGUMENT, `runIds must be a list of at most ${PURGE_NAMED_MAX} run ids`)
	const result = purgeNamedRuns(nk, runIds as string[])
	if (result.deleted > 0) logger.info('Purged %d named runs past their evidence limit', result.deleted)
	return JSON.stringify(result)
}

// {olderThanDays?, cursor?} -> {runs: [{runId, endedAt}], cursor}.
export function rpcAdminRunsExpired(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const input = parsePayload(payload)
	const days = input.olderThanDays ?? RUN_RETENTION_DAYS
	if (typeof days !== 'number' || !Number.isInteger(days) || days < 1)
		throw runtimeError(INVALID_ARGUMENT, 'olderThanDays must be a positive whole number')
	const cursor = input.cursor ?? ''
	if (typeof cursor !== 'string') throw runtimeError(INVALID_ARGUMENT, 'cursor must be a string')
	return JSON.stringify(expiredRuns(nk, Date.now() - days * DAY_MS, EXPIRED_MAX, cursor))
}
