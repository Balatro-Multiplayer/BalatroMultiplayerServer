import * as seasonReplayGateway from '../../infrastructure/gateways/season-replay.gateway.js'
import { findPlayerIdsByNakamaUserIds } from '../../infrastructure/gateways/player.gateway.js'
import { type NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { type Result, ok } from '../../shared/utils/result.js'
import { serviceQueueDispatcher } from '../service-queue/queue.service.js'
import {
	type ApplyDeps,
	type NakamaBackup,
	type NakamaLeaderboardRecord,
	type SeasonBackup,
	boardsOfKeys,
	createSeasonReplayApply,
} from './season-replay-apply.service.js'
import { callNakama, replayRuns } from './season-replay.service.js'

// The apply wired to Nakama and Postgres.

type Call = typeof callNakama

// Every page of an RPC that returns a cursor ('' = done).
async function pages<T extends { cursor: string }>(
	id: string,
	body: Record<string, unknown>,
	call: Call,
): Promise<Result<T[], NakamaRpcError>> {
	const out: T[] = []
	let cursor = ''
	do {
		const page = await call<T>(id, { ...body, cursor })
		if (!page.ok) return page
		out.push(page.value)
		cursor = page.value.cursor
	} while (cursor !== '')
	return ok(out)
}

async function backupNakama(
	season: number,
	call: Call,
): Promise<Result<NakamaBackup, NakamaRpcError>> {
	const ratings = await pages<{
		ratings: NakamaBackup['ratings']
		cursor: string
	}>('admin_ratings_season_export', { season }, call)
	if (!ratings.ok) return ratings
	const backup: NakamaBackup = {
		ratings: ratings.value.flatMap((p) => p.ratings),
		leaderboard: {},
	}
	for (const board of boardsOfKeys(
		backup.ratings.map((r) => r.key),
		season,
	)) {
		const key = `${board}:${season}`
		const records = await pages<{
			records: NakamaLeaderboardRecord[]
			cursor: string
		}>('admin_ratings_board_export', { board: key }, call)
		if (!records.ok) return records
		backup.leaderboard[key] = records.value.flatMap((p) => p.records)
	}
	return ok(backup)
}

export async function clearNakama(
	season: number,
	boards: string[],
	call: Call,
): Promise<Result<null, NakamaRpcError>> {
	const cleared = await pages<{ cleared: number; cursor: string }>(
		'admin_ratings_season_clear',
		{ season },
		call,
	)
	if (!cleared.ok) return cleared
	// A leaderboard record with no rating record behind it is not found above.
	for (const board of boards) {
		const left = await pages<{
			records: NakamaLeaderboardRecord[]
			cursor: string
		}>('admin_ratings_board_export', { board }, call)
		if (!left.ok) return left
		const owners = left.value.flatMap((p) => p.records.map((r) => r.ownerId))
		const name = board.slice(0, board.lastIndexOf(':'))
		const at = name.indexOf(':')
		for (let i = 0; i < owners.length; i += 1000) {
			const gone = await call('admin_ratings_set', {
				modId: name.slice(0, at),
				mode: name.slice(at + 1),
				season,
				entries: owners
					.slice(i, i + 1000)
					.map((userId) => ({ userId, name: '', record: null })),
			})
			if (!gone.ok) return gone
		}
	}
	return ok(null)
}

// Closes each open anti-cheat item of these runs as the owner: a dismiss, so
// the queue writes its usual audit event.
async function dismissAntiCheat(runIds: string[], note: string, owner: string) {
	let dismissed = 0
	let failed = 0
	for (const id of await seasonReplayGateway.listOpenAntiCheatItems(runIds)) {
		const result = await serviceQueueDispatcher.run(
			id,
			'dismiss',
			{ playerId: owner, role: 'admin' },
			{ note },
		)
		if (result.ok) dismissed++
		else failed++
	}
	return { dismissed, failed }
}

// Ranked games that have started and not ended, from Nakama's lobby list.
export async function activeRankedGames(
	call: Call,
): Promise<Result<number, NakamaRpcError>> {
	const lobbies = await call<{ lobbies: { type: string; started: boolean }[] }>(
		'admin_lobby_list',
		{},
	)
	if (!lobbies.ok) return lobbies
	return ok(
		lobbies.value.lobbies.filter((l) => l.type === 'ranked' && l.started)
			.length,
	)
}

export function seasonReplayApplyFor(owner: string, call: Call = callNakama) {
	const deps: ApplyDeps = {
		activeRankedGames: () => activeRankedGames(call),
		replay: (startedAt) => replayRuns(startedAt, call),
		backupNakama: (season) => backupNakama(season, call),
		backupPostgresRatings: seasonReplayGateway.listSeasonRatingRows,
		unratedMatches: seasonReplayGateway.listUnratedMatches,
		saveBackup: seasonReplayGateway.saveBackup,
		async loadBackup(id) {
			const row = await seasonReplayGateway.loadBackup(id)
			return row ? { season: row.season, data: row.data as SeasonBackup } : null
		},
		clearNakama: (season, boards) => clearNakama(season, boards, call),
		async writeNakama(batches) {
			for (const batch of batches) {
				const set = await call('admin_ratings_set', { ...batch })
				if (!set.ok) return set
			}
			return ok(null)
		},
		playerIdsOf: findPlayerIdsByNakamaUserIds,
		replacePostgres: seasonReplayGateway.replaceSeasonRatings,
		restorePostgres: seasonReplayGateway.restoreSeasonRatings,
		dismissAntiCheat: (runIds, note) => dismissAntiCheat(runIds, note, owner),
	}
	return createSeasonReplayApply(deps)
}
