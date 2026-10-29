import { describe, expect, it } from 'vitest'
import {
	type ApplyDeps,
	DISMISS_NOTE,
	type MatchResult,
	type SeasonBackup,
	createSeasonReplayApply,
	ratingRowsOf,
	restoreBatchesOf,
} from '../../features/ratings/season-replay-apply.service.js'
import { reportOf } from '../../features/ratings/season-replay.service.js'
import { err, ok } from '../../shared/utils/result.js'

const record = (rating: number, gamesPlayed = 6) => ({
	rating,
	wins: 3,
	losses: 3,
	gamesPlayed,
	seasonBest: 1234 as number | string | null,
	lastMatchAt: 1_700_000_000_000,
})

const season = { id: 1, name: 'Season 1', startedAt: new Date(5) }
const state = {
	'MultiplayerPvP:solo': {
		u1: { name: 'One', before: record(600), after: record(640) },
		u2: { name: 'Two', before: null, after: record(580) },
	},
}
const token = (before = state) => reportOf(2, before).token
const unrated: MatchResult = {
	matchId: 'run-1',
	resultPlacements: [
		{ playerId: 'p1', place: 1, rated: false },
		{ playerId: 'p2', place: 2, rated: true },
	],
}

function fakeDeps(over: Partial<ApplyDeps> = {}) {
	const log: string[] = []
	const calls: Record<string, any> = {}
	const deps: ApplyDeps = {
		activeRankedGames: async () => ok(0),
		replay: async () =>
			ok({ refs: [{ runId: 'run-1', endedAt: 1 }], state, games: 2 }),
		backupNakama: async () =>
			ok({
				ratings: [
					{ userId: 'old', key: 'MultiplayerPvP:solo:1', value: record(900) },
				],
				leaderboard: {},
			}),
		backupPostgresRatings: async () => [{ playerId: 'old' }],
		unratedMatches: async () => [unrated],
		backupWithToken: async () => false,
		saveBackup: async (_s, _by, data) => {
			log.push('backup')
			calls.backup = data
			return 'backup-1'
		},
		loadBackup: async () => null,
		clearNakama: async (s, boards) => {
			log.push('clear')
			calls.clear = [s, boards]
			return ok(null)
		},
		writeNakama: async (batches) => {
			log.push('write')
			calls.write = batches
			return ok(null)
		},
		playerIdsOf: async () =>
			new Map([
				['u1', 'p1'],
				['u2', 'p2'],
			]),
		replacePostgres: async (s, ratings, matches) => {
			log.push('postgres')
			calls.postgres = { s, ratings, matches }
		},
		restorePostgres: async () => {},
		dismissAntiCheat: async (runIds, note) => {
			log.push('dismiss')
			calls.dismiss = { runIds, note }
			return { dismissed: 2, failed: 1 }
		},
		...over,
	}
	return { deps, log, calls }
}

describe('apply', () => {
	it('backs up, then clears, writes, fixes Postgres and closes the queue items', async () => {
		const { deps, log, calls } = fakeDeps()
		const result = await createSeasonReplayApply(deps).apply(
			season,
			token(),
			'owner-1',
		)
		expect(result).toEqual(
			ok({
				backupId: 'backup-1',
				games: 2,
				players: 2,
				repairedGames: 1,
				dismissedItems: 2,
				itemsLeftOpen: 1,
			}),
		)
		expect(log).toEqual(['backup', 'clear', 'write', 'postgres', 'dismiss'])
		expect(calls.clear).toEqual([1, ['MultiplayerPvP:solo:1']])
		expect(calls.write).toEqual([
			{
				modId: 'MultiplayerPvP',
				mode: 'solo',
				season: 1,
				entries: [
					{ userId: 'u1', name: 'One', record: record(640) },
					{ userId: 'u2', name: 'Two', record: record(580) },
				],
			},
		])
		expect(calls.dismiss).toEqual({ runIds: ['run-1'], note: DISMISS_NOTE })
		expect(DISMISS_NOTE).toMatch(/Season replay/)
	})

	it('puts the old board in the backup before any write', async () => {
		const { deps, calls } = fakeDeps()
		await createSeasonReplayApply(deps).apply(season, token(), 'owner-1')
		expect((calls.backup as SeasonBackup).nakama.ratings[0].userId).toBe('old')
		expect((calls.backup as SeasonBackup).ratings).toEqual([
			{ playerId: 'old' },
		])
		expect((calls.backup as SeasonBackup).matches).toEqual([unrated])
	})

	it('marks the unrated players of a repaired game as rated', async () => {
		const { deps, calls } = fakeDeps()
		await createSeasonReplayApply(deps).apply(season, token(), 'owner-1')
		expect(calls.postgres.matches).toEqual([
			{
				matchId: 'run-1',
				resultPlacements: [
					{ playerId: 'p1', place: 1, rated: true },
					{ playerId: 'p2', place: 2, rated: true },
				],
			},
		])
		expect(
			calls.postgres.ratings.map((r: any) => [
				r.playerId,
				r.gameMode,
				r.rating,
				r.seasonBestText,
			]),
		).toEqual([
			['p1', 'ranked:solo', 640, '1234'],
			['p2', 'ranked:solo', 580, '1234'],
		])
	})

	it('refuses while a ranked game runs, and writes nothing', async () => {
		const { deps, log } = fakeDeps({ activeRankedGames: async () => ok(2) })
		const result = await createSeasonReplayApply(deps).apply(
			season,
			token(),
			'owner-1',
		)
		expect(result).toEqual(err({ code: 'active_games', count: 2 }))
		expect(log).toEqual([])
	})

	it('refuses when a game starts during the replay', async () => {
		let n = 0
		const { deps, log } = fakeDeps({
			activeRankedGames: async () => ok(n++ === 0 ? 0 : 1),
		})
		const result = await createSeasonReplayApply(deps).apply(
			season,
			token(),
			'owner-1',
		)
		expect(result).toEqual(err({ code: 'active_games', count: 1 }))
		expect(log).toEqual([])
	})

	it('refuses a token from a different dry run', async () => {
		const { deps, log } = fakeDeps()
		const result = await createSeasonReplayApply(deps).apply(
			season,
			'not-the-token',
			'owner-1',
		)
		expect(result).toEqual(err({ code: 'stale_token' }))
		expect(log).toEqual([])
	})

	it('refuses a token a backup already holds, and saves the token with the backup', async () => {
		const used = new Set<string>()
		const { deps, calls } = fakeDeps({
			backupWithToken: async (t) => used.has(t),
			saveBackup: async (_s, _by, data) => {
				used.add(data.token)
				calls.backup = data
				return 'backup-1'
			},
		})
		const service = createSeasonReplayApply(deps)
		expect((await service.apply(season, token(), 'owner-1')).ok).toBe(true)
		expect(calls.backup.token).toBe(token())
		expect(await service.apply(season, token(), 'owner-1')).toEqual(
			err({ code: 'stale_token' }),
		)
	})

	it('refuses the same token once the board holds the replay', async () => {
		const applied = {
			'MultiplayerPvP:solo': {
				u1: { name: 'One', before: record(640), after: record(640) },
				u2: { name: 'Two', before: record(580), after: record(580) },
			},
		}
		const { deps, log } = fakeDeps({
			replay: async () => ok({ refs: [], state: applied, games: 2 }),
		})
		const result = await createSeasonReplayApply(deps).apply(
			season,
			token(),
			'owner-1',
		)
		expect(result).toEqual(err({ code: 'stale_token' }))
		expect(log).toEqual([])
	})

	it('keeps the backup id when Nakama fails after the backup', async () => {
		const { deps } = fakeDeps({ writeNakama: async () => err('rejected') })
		const result = await createSeasonReplayApply(deps).apply(
			season,
			token(),
			'owner-1',
		)
		expect(result).toEqual(
			err({ code: 'nakama', reason: 'rejected', backupId: 'backup-1' }),
		)
	})

	it('drops a player without a Postgres account from the rating rows', () => {
		const rows = ratingRowsOf(state, new Map([['u1', 'p1']]), 1)
		expect(rows.map((r) => r.playerId)).toEqual(['p1'])
	})
})

describe('restore', () => {
	const backup: SeasonBackup = {
		season: { id: 1, name: 'Season 1' },
		nakama: {
			ratings: [
				{ userId: 'old', key: 'MultiplayerPvP:solo:1', value: record(900) },
				{
					userId: 'quiet',
					key: 'MultiplayerPvP:solo:1',
					value: record(500, 2),
				},
			],
			leaderboard: {
				'MultiplayerPvP:solo:1': [
					{
						ownerId: 'old',
						username: 'Old Name',
						score: 900,
						subscore: 3,
						metadata: {},
					},
				],
			},
		},
		ratings: [{ playerId: 'p9' }],
		matches: [unrated],
	}

	it('names the leaderboard players and leaves the others unnamed', () => {
		expect(restoreBatchesOf(backup.nakama, 1)[0].entries).toEqual([
			{ userId: 'old', name: 'Old Name', record: record(900) },
			{ userId: 'quiet', name: '', record: record(500, 2) },
		])
	})

	it('clears the Season, writes the old board and restores Postgres', async () => {
		const { deps, log, calls } = fakeDeps({
			loadBackup: async () => ({ season: 1, data: backup }),
			restorePostgres: async (s, ratings, matches) => {
				log.push('postgres')
				calls.restored = { s, ratings, matches }
			},
		})
		const result = await createSeasonReplayApply(deps).restore('backup-1')
		expect(result).toEqual(ok({ season: 1 }))
		expect(log).toEqual(['clear', 'write', 'postgres'])
		expect(calls.write[0].entries.map((e: any) => e.userId)).toEqual([
			'old',
			'quiet',
		])
		expect(calls.restored).toEqual({
			s: 1,
			ratings: [{ playerId: 'p9' }],
			matches: [unrated],
		})
	})

	it('refuses an unknown backup', async () => {
		const { deps } = fakeDeps()
		expect(await createSeasonReplayApply(deps).restore('nope')).toEqual(
			err({ code: 'no_backup' }),
		)
	})
})

describe('the token', () => {
	it('changes when a stored rating changes', () => {
		const moved = {
			'MultiplayerPvP:solo': {
				...state['MultiplayerPvP:solo'],
				u1: { name: 'One', before: record(641), after: record(640) },
			},
		}
		expect(token(moved)).not.toBe(token())
	})
})
