import { describe, expect, it } from 'vitest'
import { LOGS_COLLECTION, MY_RUNS_COLLECTION, RUNS_COLLECTION, type RunRecord, SYSTEM_USER_ID } from './protocol'
import { isPurgeable, purgeRuns, rpcAdminRunsPurge } from './retention'

const DAY = 24 * 60 * 60 * 1000

function run(runId: string, endedAt: number, overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId,
		code: 'ABC123',
		modId: 'MultiplayerPvP',
		seed: 's',
		stake: 1,
		options: null,
		startedAt: endedAt - 1000,
		endedAt,
		status: 'agreed',
		placements: [],
		reports: {},
		players: [
			{ id: 'a', displayName: 'A' },
			{ id: 'b', displayName: 'B' },
		],
		...overrides,
	}
}

// Storage as a key -> value map, listed in key order a page at a time.
function fakeNk(runs: RunRecord[], page = 2) {
	const objects = new Map<string, unknown>()
	const id = (o: { collection: string; key: string; userId: string }) => `${o.collection}/${o.userId}/${o.key}`
	for (const r of runs) objects.set(id({ collection: RUNS_COLLECTION, key: r.runId, userId: SYSTEM_USER_ID }), r)
	return {
		objects,
		id,
		storageList: (userId: string, collection: string, limit: number, cursor: string) => {
			const prefix = `${collection}/${userId}/`
			const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
			const start = cursor ? keys.indexOf(cursor) : 0
			const slice = keys.slice(start, start + Math.min(limit, page))
			const next = keys[start + slice.length]
			return { objects: slice.map((k) => ({ value: objects.get(k) })), cursor: next || '' }
		},
		storageDelete: (deletes: { collection: string; key: string; userId: string }[]) => {
			for (const d of deletes) objects.delete(id(d))
		},
	}
}

describe('isPurgeable', () => {
	it('purges an old clean run, and keeps a recent, flagged or disputed one', () => {
		const cutoff = 100 * DAY
		expect(isPurgeable(run('r', 10 * DAY), cutoff)).toBe(true)
		expect(isPurgeable(run('r', 200 * DAY), cutoff)).toBe(false)
		expect(isPurgeable(run('r', 10 * DAY, { flags: { a: 'hash_mismatch' } }), cutoff)).toBe(false)
		expect(isPurgeable(run('r', 10 * DAY, { status: 'disputed' }), cutoff)).toBe(false)
		expect(isPurgeable(run('r', 10 * DAY, { flags: {} }), cutoff)).toBe(true)
	})
})

describe('purgeRuns', () => {
	it("deletes each purgeable run's record, logs and player pointers across pages", () => {
		const runs = [
			run('r1', 1 * DAY),
			run('r2', 2 * DAY, { flags: { b: 'elapsed_time_gate' } }),
			run('r3', 3 * DAY),
			run('r4', 300 * DAY),
		]
		const nk = fakeNk(runs)
		for (const r of runs) {
			for (const p of r.players) {
				nk.objects.set(nk.id({ collection: LOGS_COLLECTION, key: `${r.runId}:${p.id}`, userId: SYSTEM_USER_ID }), {})
			}
		}
		expect(purgeRuns(nk as never, 100 * DAY, 10)).toEqual({ deleted: 2, more: false })
		const left = [...nk.objects.keys()]
		expect(left.filter((k) => k.startsWith(`${RUNS_COLLECTION}/`)).sort()).toEqual([
			`${RUNS_COLLECTION}/${SYSTEM_USER_ID}/r2`,
			`${RUNS_COLLECTION}/${SYSTEM_USER_ID}/r4`,
		])
		expect(left.some((k) => k.includes('r1:') || k.includes('r3:'))).toBe(false)
		expect(left.filter((k) => k.startsWith(`${LOGS_COLLECTION}/`))).toHaveLength(4)
	})

	it('stops at the cap and says there may be more', () => {
		const nk = fakeNk([run('r1', DAY), run('r2', DAY), run('r3', DAY)])
		expect(purgeRuns(nk as never, 100 * DAY, 2)).toEqual({ deleted: 2, more: true })
		expect(purgeRuns(nk as never, 100 * DAY, 2)).toEqual({ deleted: 1, more: false })
	})

	it('deletes the my_runs pointer under each player', () => {
		const r = run('r1', DAY)
		const nk = fakeNk([r])
		const pointer = (userId: string) =>
			nk.id({ collection: MY_RUNS_COLLECTION, key: `${String(9_999_999_999_999 - DAY).padStart(13, '0')}:r1`, userId })
		nk.objects.set(pointer('a'), {})
		nk.objects.set(pointer('b'), {})
		purgeRuns(nk as never, 100 * DAY, 10)
		expect(nk.objects.has(pointer('a')) || nk.objects.has(pointer('b'))).toBe(false)
	})
})

describe('rpcAdminRunsPurge', () => {
	const logger = { info: () => undefined } as unknown as nkruntime.Logger
	it('is for the server only and checks its argument', () => {
		const nk = fakeNk([])
		expect(() => rpcAdminRunsPurge({ userId: 'u' } as never, logger, nk as never, '{}')).toThrow()
		expect(() => rpcAdminRunsPurge({} as never, logger, nk as never, '{"olderThanDays":0}')).toThrow(/positive/)
		expect(JSON.parse(rpcAdminRunsPurge({} as never, logger, nk as never, '{}'))).toEqual({ deleted: 0, more: false })
	})
})
