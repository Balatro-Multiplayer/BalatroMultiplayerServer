import { describe, expect, it } from 'vitest'
import type { LogCheck, RunRecord } from '../lobby/protocol'
import { type RatingRecord, applyRatings, newRating, planRatings } from './apply'
import { nextSeasonBest } from './metrics'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: 'r1',
		code: 'ABC123',
		modId: 'MultiplayerSPDRN',
		seed: 's',
		stake: 1,
		options: null,
		startedAt: 1000,
		endedAt: 61_000,
		status: 'agreed',
		placements: [
			{ playerId: 'a', place: 1, metric: 120_000 },
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

const clean: { [id: string]: LogCheck } = { a: 'match', b: 'match' }

function seasoned(rating: number): RatingRecord {
	return { ...newRating(), rating, gamesPlayed: 10 }
}

describe('planRatings', () => {
	it('moves an even 1v1 by K/2 and records the win and loss', () => {
		const plan = planRatings(run(), clean, { a: seasoned(600), b: seasoned(600) })
		expect(plan.updates.a).toMatchObject({ rating: 620, wins: 1, losses: 0, gamesPlayed: 11, lastMatchAt: 61_000 })
		expect(plan.updates.b).toMatchObject({ rating: 580, wins: 0, losses: 1, gamesPlayed: 11 })
		expect(plan.results.a).toEqual({ delta: 20, newRating: 620, isPlacement: false, gamesPlayed: 11 })
	})

	it('hides the rating change while a player is still in placement games', () => {
		const plan = planRatings(run(), clean, {})
		expect(plan.results.a).toEqual({ delta: null, newRating: null, isPlacement: true, gamesPlayed: 1 })
		// ...but still stores it.
		expect(plan.updates.a.rating).toBeGreaterThan(600)
	})

	it('rates a partial result (the leaver was placed last by whoever stayed)', () => {
		const plan = planRatings(run({ status: 'partial' }), clean, { a: seasoned(600), b: seasoned(600) })
		expect(plan.updates.a.rating).toBe(620)
	})

	it.each(['disputed', 'abandoned', 'restarted'] as const)('does not rate a %s game', (status) => {
		const plan = planRatings(run({ status }), clean, { a: seasoned(600), b: seasoned(600) })
		expect(plan).toEqual({ updates: {}, results: {} })
	})

	it('leaves out a player whose log does not match its hash, and everyone if that leaves one', () => {
		const plan = planRatings(run(), { a: 'match', b: 'mismatch' }, { a: seasoned(600), b: seasoned(600) })
		expect(plan).toEqual({ updates: {}, results: {} })
	})

	it('still rates the honest players of a three-player game', () => {
		const three = run({
			placements: [
				{ playerId: 'a', place: 1 },
				{ playerId: 'b', place: 2 },
				{ playerId: 'c', place: 3 },
			],
			players: [
				{ id: 'a', displayName: 'A' },
				{ id: 'b', displayName: 'B' },
				{ id: 'c', displayName: 'C' },
			],
		})
		const current = { a: seasoned(600), b: seasoned(600), c: seasoned(600) }
		const plan = planRatings(three, { a: 'match', b: 'match', c: 'mismatch' }, current)
		expect(Object.keys(plan.updates).sort()).toEqual(['a', 'b'])
		expect(plan.updates.a.rating).toBe(620)
	})

	it('never drops a rating below the floor', () => {
		const plan = planRatings(run(), clean, { a: seasoned(100), b: seasoned(100) })
		expect(plan.updates.b.rating).toBe(100)
	})

	it('keeps a season-best time only when the new one is faster and plausible', () => {
		const current = { a: { ...seasoned(600), seasonBest: 100_000 }, b: seasoned(600) }
		expect(planRatings(run(), clean, current).updates.a.seasonBest).toBe(100_000)
		const faster = run({ placements: [{ playerId: 'a', place: 1, metric: 90_000 }, { playerId: 'b', place: 2 }] })
		expect(planRatings(faster, clean, current).updates.a.seasonBest).toBe(90_000)
	})
})

describe('nextSeasonBest', () => {
	it('rejects an implausible time rather than clamping it', () => {
		expect(nextSeasonBest('MultiplayerSPDRN', 5_000, null)).toBeNull()
		expect(nextSeasonBest('MultiplayerSPDRN', 7 * 3_600_000, 200_000)).toBe(200_000)
	})
	it('treats a higher PvP score as better', () => {
		expect(nextSeasonBest('MultiplayerPvP', 50, 40)).toBe(50)
		expect(nextSeasonBest('MultiplayerPvP', 30, 40)).toBe(40)
	})
	it('ignores a mod with no metric', () => {
		expect(nextSeasonBest('OtherMod', 100_000, null)).toBeNull()
	})
})

// A storage-only fake of Nakama: versioned objects, '*' = must not exist, and
// an optional hook that runs just before each write (to race it).
function fakeNk(before?: (nk: ReturnType<typeof fakeNk>) => void) {
	const objects = new Map<string, { value: RatingRecord; version: number }>()
	const boards: { [id: string]: { [owner: string]: number } } = {}
	const nk = {
		objects,
		boards,
		writes: 0,
		storageRead: (reads: { key: string; userId: string; collection: string }[]) =>
			reads.flatMap((r) => {
				const o = objects.get(`${r.userId}/${r.key}`)
				return o ? [{ ...r, value: o.value, version: String(o.version) }] : []
			}),
		storageWrite: (writes: { key: string; userId: string; value: RatingRecord; version?: string }[]) => {
			nk.writes++
			before?.(nk)
			for (const w of writes) {
				const existing = objects.get(`${w.userId}/${w.key}`)
				const ok = w.version === '*' ? !existing : existing && String(existing.version) === w.version
				if (!ok) throw new Error('version check failed')
			}
			for (const w of writes) {
				const existing = objects.get(`${w.userId}/${w.key}`)
				objects.set(`${w.userId}/${w.key}`, { value: w.value, version: (existing?.version ?? 0) + 1 })
			}
		},
		leaderboardCreate: () => undefined,
		leaderboardRecordWrite: (id: string, owner: string, _name: string, score: number) => {
			boards[id] = { ...boards[id], [owner]: score }
		},
	}
	return nk
}

const logger = { warn: () => undefined, error: () => undefined } as unknown as nkruntime.Logger

describe('applyRatings', () => {
	it('stores ratings for both players and reports their results', () => {
		const nk = fakeNk()
		const results = applyRatings(nk as never, logger, run(), 'solo', clean)
		expect(results.a.gamesPlayed).toBe(1)
		expect(nk.objects.get('a/MultiplayerSPDRN:solo:1')?.value.wins).toBe(1)
		expect(nk.objects.get('b/MultiplayerSPDRN:solo:1')?.value.losses).toBe(1)
	})

	it('retries from fresh ratings when another game wrote a player in between', () => {
		let raced = false
		const nk = fakeNk((self) => {
			if (raced) return
			raced = true
			// Another game finished for b first.
			self.objects.set('b/MultiplayerSPDRN:solo:1', { value: seasoned(900), version: 1 })
		})
		const results = applyRatings(nk as never, logger, run(), 'solo', clean)
		expect(nk.writes).toBe(2)
		// Rated against b's fresh 900, not a fresh 600.
		expect(nk.objects.get('b/MultiplayerSPDRN:solo:1')?.value.gamesPlayed).toBe(11)
		expect(results.b.gamesPlayed).toBe(11)
	})

	it('puts only players past their placement games on the leaderboard', () => {
		const nk = fakeNk()
		nk.objects.set('a/MultiplayerSPDRN:solo:1', { value: seasoned(600), version: 1 })
		applyRatings(nk as never, logger, run(), 'solo', clean)
		expect(Object.keys(nk.boards['MultiplayerSPDRN:solo:1'])).toEqual(['a'])
	})

	it('rates nobody, and writes nothing, for a disputed game', () => {
		const nk = fakeNk()
		expect(applyRatings(nk as never, logger, run({ status: 'disputed' }), 'solo', clean)).toEqual({})
		expect(nk.writes).toBe(0)
	})
})
