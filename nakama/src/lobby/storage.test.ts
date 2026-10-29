import { describe, expect, it } from 'vitest'
import { fakeNk } from '../testing/fake_nk'
import { RUNS_COLLECTION, type RunRecord, SYSTEM_USER_ID } from './protocol'
import { MY_RUNS_COLLECTION } from './protocol'
import { rpcRunGet, rpcRunsMine, runWrites } from './storage'

const logger = {} as nkruntime.Logger
const ctx = (userId: string) => ({ userId }) as unknown as nkruntime.Context

function storedRun() {
	const nk = fakeNk()
	const run = {
		runId: 'r1',
		players: [
			{ id: 'a', displayName: 'A' },
			{ id: 'b', displayName: 'B' },
		],
		flags: { b: ['hash_mismatch'] },
	} as unknown as RunRecord
	nk.storageWrite([
		{
			collection: RUNS_COLLECTION,
			key: 'r1',
			userId: SYSTEM_USER_ID,
			value: run,
		},
	])
	return nk as unknown as nkruntime.Nakama
}

describe('rpcRunGet', () => {
	it('returns the run to a participant', () => {
		const out = JSON.parse(
			rpcRunGet(ctx('a'), logger, storedRun(), JSON.stringify({ runId: 'r1' })),
		)
		expect(out.runId).toBe('r1')
	})

	it('hides the run from a non-participant as not found', () => {
		expect(() =>
			rpcRunGet(
				ctx('stranger'),
				logger,
				storedRun(),
				JSON.stringify({ runId: 'r1' }),
			),
		).toThrow('Run not found')
	})

	it('reports a missing run as not found', () => {
		expect(() =>
			rpcRunGet(
				ctx('a'),
				logger,
				storedRun(),
				JSON.stringify({ runId: 'nope' }),
			),
		).toThrow('Run not found')
	})
})

describe('rpcRunsMine', () => {
	it('answers INVALID_ARGUMENT, not an uncaught error, for a cursor Nakama refuses', () => {
		const nk = fakeNk({
			storageList: (_u: string, _c: string, _l: number, cursor: string) => {
				if (cursor) throw new Error('failed to list storage objects: Malformed cursor was used.')
				return { objects: [], cursor: '' }
			},
		}) as unknown as nkruntime.Nakama
		let thrown: any
		try {
			rpcRunsMine(ctx('a'), logger, nk, JSON.stringify({ cursor: 'junk' }))
		} catch (e) {
			thrown = e
		}
		expect(thrown).toMatchObject({ code: 3, message: 'Invalid cursor' })
		expect(JSON.parse(rpcRunsMine(ctx('a'), logger, nk, '{}'))).toEqual({ runs: [], cursor: '' })
	})

	it('still surfaces a storage failure without a cursor', () => {
		const nk = fakeNk({
			storageList: () => {
				throw new Error('db down')
			},
		}) as unknown as nkruntime.Nakama
		expect(() => rpcRunsMine(ctx('a'), logger, nk, '{}')).toThrow('db down')
	})
})

describe('runWrites', () => {
	it('gives a player who left before the run settled their place and rating in their history', () => {
		const run = {
			runId: 'r1',
			code: 'ABC123',
			modId: 'MultiplayerPvP',
			startedAt: 1,
			endedAt: 2,
			status: 'partial',
			players: [
				{ id: 'a', displayName: 'A' },
				{ id: 'b', displayName: 'B' },
			],
			placements: [
				{ playerId: 'b', place: 1 },
				{ playerId: 'a', place: 2 },
			],
			ratings: { a: { delta: -12, newRating: 988, isPlacement: false, gamesPlayed: 9 } },
		} as unknown as RunRecord
		const writes = runWrites(run, {}, () => 'h')
		const mine = writes.filter((w) => w.collection === MY_RUNS_COLLECTION && w.userId === 'a')[0]
		expect(mine.value).toMatchObject({ status: 'partial', place: 2, rating: { delta: -12 } })
	})
})
