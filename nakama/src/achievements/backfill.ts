// Fills each player's achievement progress from the games already stored
// (match_runs and match_logs), with the same rules recordRun uses for a new
// game. A player is filled once: their progress is rebuilt from all their
// stored games, oldest first, so a game recordRun already counted is not
// counted twice, and then marked backfilled. Milestones and avatars earned
// before are kept. Nobody is notified: the picker and the website read the
// progress, and a toast per old game would be a storm.
//
// Paged over player profiles, so the API calls it until the cursor is ''.
// After the last page it records that it is done, and later calls return at
// once unless forced. Does nothing while achievementsEnabled is off.
import { readConfig } from '../config'
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import {
	LOGS_COLLECTION,
	MY_RUNS_COLLECTION,
	RUNS_COLLECTION,
	type RunRecord,
	SYSTEM_USER_ID,
} from '../lobby/protocol'
import { logKey } from '../lobby/storage'
import { PLAYER_COLLECTION, PROFILE_KEY, profileOf } from '../player/profile'
import { listCollectionPage, parsePayload, requireServer } from '../rpc'
import { type LogEvent, eventsOfStored } from '../shared/replay/events'
import type { LogFacts } from './facts'
import { FINISHED_STATUSES } from './eligibility'
import { type Progress, emptyProgress, withMilestone } from './progress'
import { factsByPlayer, outcomeOf, withEarned } from './record'
import type { Milestone } from '../shared/avatars/rules'
import { readProgress, updateProgress } from './storage'

export const BACKFILL_COLLECTION = 'achievements_backfill'
export const BACKFILL_KEY = 'state'
const RUN_KEY = 'run'
const DISCORD_MILESTONE: Milestone = 'discordLinked'

// Players per call: each one reads all their games and logs.
const PLAYER_PAGE = 20
const LIST_PAGE = 100
const READ_BATCH = 100

export interface StoredGame {
	run: RunRecord
	facts: { [userId: string]: LogFacts }
}

const byEndThenId = (a: StoredGame, b: StoredGame) =>
	a.run.endedAt - b.run.endedAt ||
	(a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0)

// Pure: the player's progress rebuilt from their stored games, keeping what
// `before` had earned (milestones, unlocked avatars), marked backfilled.
export function backfilledProgress(
	before: Progress,
	playerId: string,
	games: StoredGame[],
	privileges: readonly string[],
	discordLinked: boolean,
): Progress {
	let progress: Progress = {
		...emptyProgress(),
		milestones: before.milestones,
		unlocked: before.unlocked,
	}
	for (const game of games.slice().sort(byEndThenId))
		progress = outcomeOf(
			progress,
			game.run,
			playerId,
			game.facts,
			privileges,
		).progress
	if (discordLinked) progress = withMilestone(progress, DISCORD_MILESTONE)
	return { ...withEarned(progress, privileges).progress, backfilled: true }
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

function runIdsOf(nk: nkruntime.Nakama, userId: string): string[] {
	const ids: string[] = []
	let cursor = ''
	do {
		const page = nk.storageList(userId, MY_RUNS_COLLECTION, LIST_PAGE, cursor)
		for (const o of page.objects || []) {
			const runId = (o.value as { runId?: unknown }).runId
			if (typeof runId === 'string') ids.push(runId)
		}
		cursor = page.cursor || ''
	} while (cursor !== '')
	return ids
}

// The player's finished games with every participant's log facts.
export function storedGamesOf(
	nk: nkruntime.Nakama,
	userId: string,
): StoredGame[] {
	const runs: RunRecord[] = []
	for (const ids of chunks(runIdsOf(nk, userId), READ_BATCH)) {
		const objects = nk.storageRead(
			ids.map((key) => ({
				collection: RUNS_COLLECTION,
				key,
				userId: SYSTEM_USER_ID,
			})),
		)
		for (const o of objects) {
			const run = o.value as unknown as RunRecord
			if (FINISHED_STATUSES.indexOf(run.status) !== -1) runs.push(run)
		}
	}
	const games: StoredGame[] = []
	for (const batch of chunks(runs, Math.max(1, Math.floor(READ_BATCH / 2)))) {
		const reads = batch.flatMap((run) =>
			run.players.map((p) => ({
				collection: LOGS_COLLECTION,
				key: logKey(run.runId, p.id),
				userId: SYSTEM_USER_ID,
			})),
		)
		const logs: { [key: string]: unknown } = {}
		for (const o of nk.storageRead(reads)) logs[o.key] = o.value
		for (const run of batch) {
			const events: { [userId: string]: LogEvent[] } = {}
			for (const p of run.players)
				events[p.id] = eventsOfStored(logs[logKey(run.runId, p.id)])
			games.push({ run, facts: factsByPlayer(run, events) })
		}
	}
	return games
}

// Fills one player unless already filled. True when it filled them.
export function backfillPlayer(
	nk: nkruntime.Nakama,
	userId: string,
	privileges: readonly string[],
	discordLinked: boolean,
): boolean {
	const stored = readProgress(nk, userId)
	if (stored && stored.progress.backfilled) return false
	let filled = false
	// The games are read inside the change: a retry after a concurrent
	// recordRun write sees the game it counted.
	updateProgress(nk, userId, (before) => {
		if (before.backfilled) {
			filled = false
			return before
		}
		filled = true
		return backfilledProgress(
			before,
			userId,
			storedGamesOf(nk, userId),
			privileges,
			discordLinked,
		)
	})
	return filled
}

function isDone(nk: nkruntime.Nakama): boolean {
	return (
		nk.storageRead([
			{
				collection: BACKFILL_COLLECTION,
				key: BACKFILL_KEY,
				userId: SYSTEM_USER_ID,
			},
		]).length > 0
	)
}

function markDone(nk: nkruntime.Nakama) {
	nk.storageWrite([
		{
			collection: BACKFILL_COLLECTION,
			key: BACKFILL_KEY,
			userId: SYSTEM_USER_ID,
			value: { doneAt: Date.now() },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

interface PageCounts {
	filled: number
	skipped: number
	failed: number
}

const NO_COUNTS: PageCounts = { filled: 0, skipped: 0, failed: 0 }

const answer = (
	enabled: boolean,
	done: boolean,
	counts: PageCounts,
	cursor: string,
) => JSON.stringify({ enabled, done, ...counts, cursor })

// Players of this run that failed, kept between pages so the last page knows.
function readRunFailures(nk: nkruntime.Nakama): number {
	const stored = nk.storageRead([
		{ collection: BACKFILL_COLLECTION, key: RUN_KEY, userId: SYSTEM_USER_ID },
	])[0]
	const failures = stored
		? (stored.value as { failures?: unknown }).failures
		: 0
	return typeof failures === 'number' ? failures : 0
}

function writeRunFailures(nk: nkruntime.Nakama, failures: number) {
	nk.storageWrite([
		{
			collection: BACKFILL_COLLECTION,
			key: RUN_KEY,
			userId: SYSTEM_USER_ID,
			value: { failures },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

function fillPage(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	objects: nkruntime.StorageObject[],
): PageCounts {
	const counts = { ...NO_COUNTS }
	for (const object of objects) {
		if (object.key !== PROFILE_KEY) continue
		const profile = profileOf(object.value, '')
		try {
			if (
				backfillPlayer(
					nk,
					object.userId,
					profile.privileges,
					profile.discordIdHash !== null,
				)
			)
				counts.filled++
			else counts.skipped++
		} catch (e) {
			// One bad record must not stop everyone else; the run is not marked done, so the next run retries them.
			counts.failed++
			logger.error(
				'Achievement backfill: could not fill %s: %v',
				object.userId,
				e,
			)
		}
	}
	return counts
}

function parseInput(payload: string): { cursor: string; force: boolean } {
	const input = parsePayload(payload)
	if (input.cursor !== undefined && typeof input.cursor !== 'string')
		throw runtimeError(INVALID_ARGUMENT, 'Invalid cursor')
	if (input.force !== undefined && typeof input.force !== 'boolean')
		throw runtimeError(INVALID_ARGUMENT, 'force must be a boolean')
	return {
		cursor: (input.cursor as string | undefined) || '',
		force: input.force === true,
	}
}

// {cursor?, force?} -> {enabled, done, filled, skipped, failed, cursor}.
// skipped counts players filled before. force lists the players again after it is done.
// done is true only when the last page was reached and no player of the run failed.
export function rpcAdminAchievementsBackfill(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const { cursor, force } = parseInput(payload)
	if (!readConfig(nk).achievementsEnabled)
		return answer(false, false, NO_COUNTS, '')
	if (cursor === '' && !force && isDone(nk))
		return answer(true, true, NO_COUNTS, '')

	const page = listCollectionPage(nk, PLAYER_COLLECTION, PLAYER_PAGE, cursor)
	const counts = fillPage(nk, logger, page.objects || [])
	const next = page.cursor || ''
	const failures = (cursor === '' ? 0 : readRunFailures(nk)) + counts.failed
	if (next !== '' || failures > 0) writeRunFailures(nk, failures)
	const done = next === '' && failures === 0
	if (done) markDone(nk)
	logger.info(
		'Achievement backfill: %d filled, %d already filled, %d failed%s',
		counts.filled,
		counts.skipped,
		counts.failed,
		done ? ', done' : '',
	)
	return answer(true, done, counts, next)
}
