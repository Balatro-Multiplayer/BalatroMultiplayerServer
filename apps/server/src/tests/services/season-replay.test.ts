import { describe, expect, it } from 'vitest'
import { replaySeason, reportOf, runsMayBePurged } from '../../features/ratings/season-replay.service.js'
import { err, ok } from '../../shared/utils/result.js'

const record = (rating: number) => ({
	rating,
	wins: 0,
	losses: 0,
	gamesPlayed: 1,
	seasonBest: null,
	lastMatchAt: 0,
})

describe('reportOf', () => {
	it('counts a player as changed when the rating differs or nothing was stored', () => {
		const state = {
			'ModA:solo': {
				same: { name: 'S', before: record(600), after: record(600) },
				moved: { name: 'M', before: record(600), after: record(620) },
				fresh: { name: 'F', before: null, after: record(610) },
			},
		}
		const report = reportOf(5, state)
		expect(report.games).toBe(5)
		expect(report.changedPlayers).toBe(2)
		expect(report.players.map((p) => [p.userId, p.modId, p.mode])).toEqual([
			['fresh', 'ModA', 'solo'],
			['moved', 'ModA', 'solo'],
			['same', 'ModA', 'solo'],
		])
	})

	describe('token', () => {
		const shuffled = (r: ReturnType<typeof record>) => ({
			lastMatchAt: r.lastMatchAt,
			seasonBest: r.seasonBest,
			gamesPlayed: r.gamesPlayed,
			losses: r.losses,
			wins: r.wins,
			rating: r.rating,
		})
		const stateOf = (before: any, after: any) => ({
			'ModA:solo': { u1: { name: 'U', before, after } },
		})

		it('ignores the key order of the stored records', () => {
			const a = reportOf(3, stateOf(record(600), record(620)))
			const b = reportOf(3, stateOf(shuffled(record(600)), shuffled(record(620))))
			expect(b.token).toBe(a.token)
		})

		it('treats a missing optional field like null', () => {
			const { seasonBest: _, ...bare } = record(600)
			const a = reportOf(3, stateOf(record(600), record(620)))
			const b = reportOf(3, stateOf(bare, record(620)))
			expect(b.token).toBe(a.token)
		})

		it('changes with a rating, a missing before or the game count', () => {
			const base = reportOf(3, stateOf(record(600), record(620))).token
			expect(reportOf(3, stateOf(record(600), record(621))).token).not.toBe(base)
			expect(reportOf(3, stateOf(null, record(620))).token).not.toBe(base)
			expect(reportOf(4, stateOf(record(600), record(620))).token).not.toBe(base)
		})
	})
})

describe('replaySeason', () => {
	it('pages the runs, folds them in end-time order and carries the state', async () => {
		const calls: [string, any][] = []
		const pages = [
			{ runs: [{ runId: 'late', endedAt: 30 }, { runId: 'early', endedAt: 10 }], cursor: 'c1' },
			{ runs: [{ runId: 'mid', endedAt: 20 }], cursor: '' },
		]
		const call = (async (id: string, body: any) => {
			calls.push([id, body])
			if (id === 'admin_ratings_replay_list') return ok(pages.shift())
			return ok({ state: { 'M:solo': {} }, rated: body.runIds.length })
		}) as any
		const result = await replaySeason(new Date(5), call)
		expect(calls[0]).toEqual(['admin_ratings_replay_list', { startedAt: 5, cursor: '' }])
		expect(calls[1][1].cursor).toBe('c1')
		expect(calls[2]).toEqual([
			'admin_ratings_replay_fold',
			{ runIds: ['early', 'mid', 'late'], state: {} },
		])
		expect(result.ok && result.value.games).toBe(3)
	})

	it('batches the fold calls and passes each state on', async () => {
		const runs = Array.from({ length: 250 }, (_, i) => ({ runId: `r${i}`, endedAt: i }))
		const folds: any[] = []
		let n = 0
		const call = (async (id: string, body: any) => {
			if (id === 'admin_ratings_replay_list') return ok({ runs, cursor: '' })
			folds.push(body)
			return ok({ state: { 'M:solo': { [`p${++n}`]: { name: '', before: null, after: record(1) } } }, rated: body.runIds.length })
		}) as any
		await replaySeason(new Date(0), call)
		expect(folds.map((f) => f.runIds.length)).toEqual([100, 100, 50])
		expect(Object.keys(folds[2].state['M:solo'])).toEqual(['p2'])
	})

	it('stops on a Nakama error', async () => {
		const result = await replaySeason(new Date(0), (async () => err('rejected')) as any)
		expect(result).toEqual(err('rejected'))
	})
})

describe('runsMayBePurged', () => {
	const DAY = 24 * 60 * 60 * 1000
	const now = new Date(1000 * DAY)
	it('is true only for a Season that began before the 180 day window', () => {
		expect(runsMayBePurged(new Date(now.getTime() - 181 * DAY), now)).toBe(true)
		expect(runsMayBePurged(new Date(now.getTime() - 179 * DAY), now)).toBe(false)
	})
})
