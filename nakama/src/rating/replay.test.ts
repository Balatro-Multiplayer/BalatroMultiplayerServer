import { beforeEach, describe, expect, it } from 'vitest'
import { RATINGS_COLLECTION, RUNS_COLLECTION, SYSTEM_USER_ID, type RunRecord } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { type RatingRecord, newRating } from './apply'
import { rpcAdminRatingsReplayFold, rpcAdminRatingsReplayList } from './replay'
import { configureSeason } from './season'

const T0 = 1_000_000_000_000

function run(runId: string, endedAt: number, overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId,
		code: 'ABC123',
		modId: 'MultiplayerSPDRN',
		seed: 's',
		stake: 1,
		options: null,
		startedAt: endedAt - 60_000,
		endedAt,
		status: 'agreed',
		placements: [
			{ playerId: 'a', place: 1 },
			{ playerId: 'b', place: 2 },
		],
		reports: {},
		players: [
			{ id: 'a', displayName: 'A' },
			{ id: 'b', displayName: 'B' },
		],
		rankedMode: 'solo',
		...overrides,
	}
}

function nkWith(runs: RunRecord[]) {
	const nk = fakeNk()
	for (const r of runs)
		nk.objects.set(`${RUNS_COLLECTION}/${SYSTEM_USER_ID}/${r.runId}`, { value: r, version: 1 })
	return nk
}

const call = (rpc: typeof rpcAdminRatingsReplayList, nk: any, body: unknown) =>
	JSON.parse(rpc(serverCtx(), fakeLogger as any, nk, JSON.stringify(body)))

beforeEach(() => configureSeason('1'))

describe('rpcAdminRatingsReplayList', () => {
	it('lists the ranked, rated games that ended in the season', () => {
		const nk = nkWith([
			run('old', T0 - 1),
			run('in', T0),
			run('casual', T0 + 1, { rankedMode: undefined }),
			run('disputed', T0 + 2, { status: 'disputed' }),
			run('partial', T0 + 3, { status: 'partial' }),
			run('flagged', T0 + 4, { flags: { a: 'hash_mismatch' } }),
		])
		const page = call(rpcAdminRatingsReplayList, nk, { startedAt: T0, cursor: '' })
		expect(page.runs.map((r: any) => r.runId).sort()).toEqual(['flagged', 'in', 'partial'])
		expect(page.cursor).toBe('')
	})

	it('refuses a player', () => {
		expect(() =>
			rpcAdminRatingsReplayList(playerCtx('a') as any, fakeLogger as any, nkWith([]) as any, '{"startedAt":0}'),
		).toThrow()
	})
})

describe('rpcAdminRatingsReplayFold', () => {
	it('folds games in the order given and keeps the stored rating as before', () => {
		const stored: RatingRecord = { ...newRating(), rating: 650, gamesPlayed: 10, lastMatchAt: T0 }
		const nk = nkWith([run('r1', T0 + 1000), run('r2', T0 + 2000)])
		nk.objects.set(`${RATINGS_COLLECTION}/a/MultiplayerSPDRN:solo:1`, { value: stored, version: 1 })
		const out = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r1', 'r2'], state: {} })
		const a = out.state['MultiplayerSPDRN:solo'].a
		expect(a.before).toEqual(stored)
		// The replay starts from an empty board, not from the stored rating.
		expect(a.after.gamesPlayed).toBe(2)
		expect(a.after.wins).toBe(2)
		expect(out.state['MultiplayerSPDRN:solo'].b.before).toBeNull()
		expect(out.rated).toBe(2)
	})

	it('continues from the state it is given and writes nothing', () => {
		const nk = nkWith([run('r1', T0 + 1000), run('r2', T0 + 2000)])
		const first = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r1'], state: {} })
		const second = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r2'], state: first.state })
		const whole = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r1', 'r2'], state: {} })
		expect(second.state).toEqual(whole.state)
		expect([...nk.objects.keys()].filter((key) => key.startsWith(RATINGS_COLLECTION))).toEqual([])
	})

	it('rates a game that carries a flag', () => {
		const nk = nkWith([run('r1', T0, { flags: { b: 'hash_mismatch' } })])
		const out = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r1'], state: {} })
		expect(out.state['MultiplayerSPDRN:solo'].a.after.gamesPlayed).toBe(1)
	})

	it('seeds a player with no record this season from last season', () => {
		configureSeason('2')
		const old: RatingRecord = { ...newRating(), rating: 700, gamesPlayed: 10, lastMatchAt: T0 }
		const nk = nkWith([run('r1', T0 + 1000)])
		nk.objects.set(`${RATINGS_COLLECTION}/a/MultiplayerSPDRN:solo:1`, { value: old, version: 1 })
		const out = call(rpcAdminRatingsReplayFold, nk, { runIds: ['r1'], state: {} })
		const fresh = call(rpcAdminRatingsReplayFold, nkWith([run('r1', T0 + 1000)]), { runIds: ['r1'], state: {} })
		const a = out.state['MultiplayerSPDRN:solo'].a
		expect(a.before).toBeNull()
		expect(a.after.rating).not.toBe(fresh.state['MultiplayerSPDRN:solo'].a.after.rating)
		expect(a.after.gamesPlayed).toBe(1)
	})

	it('decays a player idle before a game', () => {
		const day = 86_400_000
		const veteran = { before: null, after: { ...newRating(), rating: 1500, gamesPlayed: 10, lastMatchAt: T0 } }
		const state = { 'MultiplayerSPDRN:solo': { a: veteran } }
		const soon = call(rpcAdminRatingsReplayFold, nkWith([run('r1', T0 + 1000)]), { runIds: ['r1'], state })
		const late = call(rpcAdminRatingsReplayFold, nkWith([run('r1', T0 + 30 * day)]), { runIds: ['r1'], state })
		const rating = (out: any) => out.state['MultiplayerSPDRN:solo'].a.after.rating
		expect(rating(late)).toBeLessThan(rating(soon) - 50)
	})
})
