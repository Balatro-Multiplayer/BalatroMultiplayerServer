// Finished games in Nakama storage: the run record and each player's replay
// log (owned by the system user), plus a pointer per participant so players
// can list their own runs. Written by the bmp_lobby match; read by the run
// RPCs below.
import { INVALID_ARGUMENT, NOT_FOUND, UNAUTHENTICATED, runtimeError } from '../errors'
import {
	LOGS_COLLECTION,
	MY_RUNS_COLLECTION,
	type PlayerLog,
	RUNS_COLLECTION,
	type RunRecord,
	SYSTEM_USER_ID,
} from './protocol'

function logKey(runId: string, playerId: string): string {
	return `${runId}:${playerId}`
}

// The storage writes for a finished run. Pure, so it can be tested.
export function runWrites(
	run: RunRecord,
	logs: { [userId: string]: PlayerLog },
): nkruntime.StorageWriteRequest[] {
	const writes: nkruntime.StorageWriteRequest[] = [
		{
			collection: RUNS_COLLECTION,
			key: run.runId,
			userId: SYSTEM_USER_ID,
			value: { ...run },
			permissionRead: 2,
			permissionWrite: 0,
		},
	]
	for (const player of run.players) {
		const log = logs[player.id]
		writes.push({
			collection: LOGS_COLLECTION,
			key: logKey(run.runId, player.id),
			userId: SYSTEM_USER_ID,
			value: {
				events: log ? log.events : [],
				eventCount: log ? log.events.length : 0,
				truncated: log ? log.truncated : false,
			},
			permissionRead: 0,
			permissionWrite: 0,
		})
		const placement = run.placements.filter((p) => p.playerId === player.id)[0]
		writes.push({
			collection: MY_RUNS_COLLECTION,
			key: run.runId,
			userId: player.id,
			value: {
				runId: run.runId,
				modId: run.modId,
				endedAt: run.endedAt,
				status: run.status,
				place: placement ? placement.place : null,
			},
			permissionRead: 1,
			permissionWrite: 0,
		})
	}
	return writes
}

export function saveRun(
	nk: nkruntime.Nakama,
	run: RunRecord,
	logs: { [userId: string]: PlayerLog },
) {
	nk.storageWrite(runWrites(run, logs))
}

function requireUser(ctx: nkruntime.Context): string {
	if (!ctx.userId)
		throw runtimeError(UNAUTHENTICATED, 'Run RPCs need a player session')
	return ctx.userId
}

function parseInput(payload: string): { [key: string]: unknown } {
	if (!payload) return {}
	try {
		const data = JSON.parse(payload)
		// Lua clients encode an empty table as [].
		if (Array.isArray(data) && data.length === 0) return {}
		if (typeof data === 'object' && data !== null && !Array.isArray(data))
			return data
	} catch (e) {
		// Falls through to the error below.
	}
	throw runtimeError(INVALID_ARGUMENT, 'Payload must be a JSON object')
}

function readRun(nk: nkruntime.Nakama, runId: unknown): RunRecord {
	if (typeof runId !== 'string' || runId === '')
		throw runtimeError(INVALID_ARGUMENT, 'runId is required')
	const objects = nk.storageRead([
		{ collection: RUNS_COLLECTION, key: runId, userId: SYSTEM_USER_ID },
	])
	if (objects.length === 0) throw runtimeError(NOT_FOUND, 'Run not found')
	return objects[0].value as unknown as RunRecord
}

// {runId} -> the run record.
export function rpcRunGet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireUser(ctx)
	return JSON.stringify(readRun(nk, parseInput(payload).runId))
}

// {runId, playerId?} -> {logs: {playerId: {events, eventCount, truncated}}}.
// Only the run's participants may read its logs.
export function rpcRunLogs(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const input = parseInput(payload)
	const run = readRun(nk, input.runId)
	if (!run.players.some((p) => p.id === userId))
		throw runtimeError(NOT_FOUND, 'Run not found')
	const wanted = run.players.filter(
		(p) => typeof input.playerId !== 'string' || p.id === input.playerId,
	)
	const objects = nk.storageRead(
		wanted.map((p) => ({
			collection: LOGS_COLLECTION,
			key: logKey(run.runId, p.id),
			userId: SYSTEM_USER_ID,
		})),
	)
	const logs: { [playerId: string]: unknown } = {}
	for (const object of objects) {
		logs[object.key.slice(run.runId.length + 1)] = object.value
	}
	return JSON.stringify({ logs })
}

const RUNS_PAGE = 20

// {cursor?} -> {runs: [{runId, modId, endedAt, status, place}], cursor}.
export function rpcRunsMine(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const input = parseInput(payload)
	const cursor = typeof input.cursor === 'string' ? input.cursor : ''
	const page = nk.storageList(userId, MY_RUNS_COLLECTION, RUNS_PAGE, cursor)
	return JSON.stringify({
		runs: (page.objects || []).map((o) => o.value),
		cursor: page.cursor || '',
	})
}
