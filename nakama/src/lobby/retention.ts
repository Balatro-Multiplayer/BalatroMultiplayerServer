// Run retention: a finished game's record, logs and player pointers are kept
// for RUN_RETENTION_DAYS, then deleted -- unless the run is flagged or
// disputed, which a moderator may still need (the API's matchRunLogs
// "null expiresAt = keep" rule). The API's daily job calls admin_runs_purge.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { parsePayload, requireServer } from '../rpc'
import { LOGS_COLLECTION, MY_RUNS_COLLECTION, RUNS_COLLECTION, type RunRecord, SYSTEM_USER_ID } from './protocol'
import { logKey, myRunKey } from './storage'

export const RUN_RETENTION_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000
const LIST_PAGE = 100
// Runs deleted per call at most, so one call stays short; the caller repeats
// while `more` is set.
export const PURGE_MAX = 500

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

// Deletes up to `max` purgeable runs that ended before `cutoff`. `more` means
// there may be others left.
export function purgeRuns(nk: nkruntime.Nakama, cutoff: number, max: number): { deleted: number; more: boolean } {
	let deleted = 0
	let cursor = ''
	do {
		const page = nk.storageList(SYSTEM_USER_ID, RUNS_COLLECTION, LIST_PAGE, cursor)
		for (const o of page.objects || []) {
			const run = o.value as unknown as RunRecord
			if (!isPurgeable(run, cutoff)) continue
			if (deleted >= max) return { deleted, more: true }
			nk.storageDelete(runObjects(run))
			deleted++
		}
		cursor = page.cursor || ''
	} while (cursor)
	return { deleted, more: false }
}

// {olderThanDays?} -> {deleted, more}.
export function rpcAdminRunsPurge(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const days = parsePayload(payload).olderThanDays ?? RUN_RETENTION_DAYS
	if (typeof days !== 'number' || !Number.isInteger(days) || days < 1)
		throw runtimeError(INVALID_ARGUMENT, 'olderThanDays must be a positive whole number')
	const result = purgeRuns(nk, Date.now() - days * DAY_MS, PURGE_MAX)
	if (result.deleted > 0) logger.info('Purged %d runs older than %d days', result.deleted, days)
	return JSON.stringify(result)
}
