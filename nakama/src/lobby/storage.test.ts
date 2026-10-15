import { describe, expect, it } from 'vitest'
import { fakeNk } from '../testing/fake_nk'
import { RUNS_COLLECTION, type RunRecord, SYSTEM_USER_ID } from './protocol'
import { rpcRunGet } from './storage'

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
	nk.storageWrite([{ collection: RUNS_COLLECTION, key: 'r1', userId: SYSTEM_USER_ID, value: run }])
	return nk as unknown as nkruntime.Nakama
}

describe('rpcRunGet', () => {
	it('returns the run to a participant', () => {
		const out = JSON.parse(rpcRunGet(ctx('a'), logger, storedRun(), JSON.stringify({ runId: 'r1' })))
		expect(out.runId).toBe('r1')
	})

	it('hides the run from a non-participant as not found', () => {
		expect(() => rpcRunGet(ctx('stranger'), logger, storedRun(), JSON.stringify({ runId: 'r1' }))).toThrow(
			'Run not found',
		)
	})

	it('reports a missing run as not found', () => {
		expect(() => rpcRunGet(ctx('a'), logger, storedRun(), JSON.stringify({ runId: 'nope' }))).toThrow('Run not found')
	})
})
