import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import type { RunRecord } from '../lobby/protocol'
import { saveRun } from '../lobby/storage'
import { defaultProfile, readProfile, writeProfile } from '../player/profile'
import { eventsByPlayer } from '../shared/replay/events'
import { A, B, runOf } from '../testing/achievement_fixtures'
import { type FakeNk, fakeLogger, fakeNk, serverCtx } from '../testing/fake_nk'
import {
	type Tuple,
	closing,
	logOf,
	play,
	pvpOpening,
} from '../testing/replay_fixtures'
import { rpcAdminAchievementsBackfill } from './backfill'
import { emptyProgress } from './progress'
import { recordRun } from './record'
import { rpcAdminAvatarsReset } from './reset'
import { progressFor, readProgress, writeProgress } from './storage'

const HOUR = 60 * 60 * 1000

function stack(enabled = true): FakeNk {
	const nk = fakeNk({
		sha256Hash: (s: string) => `h${s.length}`,
		accountGetId: (id: string) => ({ user: { id, displayName: id } }),
		accountUpdateId: () => undefined,
	})
	writeConfig(nk as any, { ...DEFAULT_CONFIG, achievementsEnabled: enabled })
	for (const id of [A, B]) writeProfile(nk as any, id, defaultProfile(id))
	return nk
}

function hands(n: number): Tuple[] {
	return Array.from({ length: n }, (_, i) => play(100 + i * 1000, 10 + i * 2))
}

const pvpLog = (result: 'win' | 'loss', handCount = 4) =>
	logOf([
		...pvpOpening('Blue Deck'),
		...hands(handCount),
		...closing(9000, result),
	])

// A finished game A wins, `n` hours after the fixture's, stored as the match stores it.
function game(n: number, over: Partial<RunRecord> = {}) {
	const start = runOf().startedAt + n * HOUR
	const run = runOf({
		runId: `run-${n}`,
		startedAt: start,
		endedAt: start + 10 * 60 * 1000,
		...over,
	})
	const logs = { [A]: pvpLog('win'), [B]: pvpLog('loss') }
	return { run, logs }
}

function store(nk: FakeNk, games: ReturnType<typeof game>[]) {
	for (const g of games) saveRun(nk as any, g.run, g.logs)
}

const backfill = (nk: FakeNk, input: object = {}) =>
	JSON.parse(
		rpcAdminAchievementsBackfill(
			serverCtx(),
			fakeLogger,
			nk as any,
			JSON.stringify(input),
		),
	)

function backfillAll(nk: FakeNk, input: object = {}) {
	let result = backfill(nk, input)
	while (result.cursor !== '')
		result = backfill(nk, { ...input, cursor: result.cursor })
	return result
}

// Five games A wins, one a draw-length game that never counts.
const history = () => [
	game(1),
	game(2),
	game(3),
	game(4, { endedAt: runOf().startedAt + 4 * HOUR + 1000 }),
	game(5),
	game(6),
]

describe('admin_achievements_backfill', () => {
	it('fills progress from the stored games with the live rules, without a toast', () => {
		const nk = stack()
		store(nk, history())
		backfillAll(nk)

		const live = stack()
		for (const g of history())
			recordRun(live as any, fakeLogger, g.run, eventsByPlayer(g.logs))

		const a = progressFor(nk as any, A)
		expect(a.counters).toMatchObject({
			games: 5,
			wins: 5,
			pvpGames: 5,
			hands: 20,
		})
		// 1 win, a 3- and a 5-win streak, 5 games.
		expect(a.unlocked).toEqual([
			'j_baron',
			'j_fortune_teller',
			'j_swashbuckler',
			'j_sixth_sense',
		])
		expect(progressFor(nk as any, B).counters).toMatchObject({
			games: 5,
			wins: 0,
		})
		for (const id of [A, B]) {
			const filled = progressFor(nk as any, id)
			expect(filled.backfilled).toBe(true)
			expect({ ...filled, backfilled: false }).toEqual(
				progressFor(live as any, id),
			)
		}
		expect(nk.notifications).toEqual([])
	})

	it('changes nothing when it runs a second time', () => {
		const nk = stack()
		store(nk, history())
		backfillAll(nk)
		const first = readProgress(nk as any, A)
		const again = backfillAll(nk, { force: true })
		expect(again).toMatchObject({ filled: 0 })
		expect(readProgress(nk as any, A)).toEqual(first)
	})

	it('does not list players again once it has finished, unless forced', () => {
		const nk = stack()
		store(nk, history())
		expect(backfillAll(nk)).toMatchObject({ done: true, filled: 2 })
		expect(backfill(nk)).toEqual({
			enabled: true,
			done: true,
			filled: 0,
			skipped: 0,
			failed: 0,
			cursor: '',
		})
		expect(backfill(nk, { force: true })).toMatchObject({
			done: true,
			filled: 0,
			skipped: 2,
		})
	})

	it('stays not done while a player failed, and fills them on the next run', () => {
		const nk = stack()
		store(nk, history())
		const write = nk.storageWrite
		let broken = true
		nk.storageWrite = (writes: any[]) => {
			if (broken && writes.some((w) => w.userId === B)) throw new Error('disk')
			return write(writes)
		}
		expect(backfillAll(nk)).toMatchObject({ done: false, failed: 1 })
		broken = false
		expect(backfill(nk)).toMatchObject({
			done: true,
			filled: 1,
			skipped: 1,
			failed: 0,
		})
		expect(backfill(nk)).toMatchObject({ done: true, filled: 0, skipped: 0 })
	})

	it('does not count twice a game already counted live', () => {
		const nk = stack()
		const games = history()
		store(nk, games)
		recordRun(
			nk as any,
			fakeLogger,
			games[5].run,
			eventsByPlayer(games[5].logs),
		)
		expect(progressFor(nk as any, A).counters.games).toBe(1)
		backfillAll(nk)
		expect(progressFor(nk as any, A).counters.games).toBe(5)
	})

	it('keeps what was earned before it ran, and earns Scholar for a linked Discord', () => {
		const nk = stack()
		store(nk, [game(1)])
		writeProfile(nk as any, A, { ...defaultProfile(A), discordIdHash: 'hash' })
		writeProgress(nk as any, A, {
			...emptyProgress(),
			milestones: ['sub8SpdrnRun'],
			unlocked: ['j_runner'],
		})
		backfillAll(nk)
		const a = progressFor(nk as any, A)
		expect(a.milestones).toEqual(['sub8SpdrnRun', 'discordLinked'])
		expect(a.unlocked).toEqual(['j_runner', 'j_baron', 'j_scholar'])
	})

	it('earns nothing while achievements are off, and runs once they are on', () => {
		const nk = stack(false)
		store(nk, history())
		expect(backfill(nk)).toMatchObject({
			enabled: false,
			done: false,
			cursor: '',
		})
		expect(readProgress(nk as any, A)).toBeNull()
		writeConfig(nk as any, { ...DEFAULT_CONFIG, achievementsEnabled: true })
		expect(backfillAll(nk)).toMatchObject({ done: true, filled: 2 })
	})

	it('is not undone by the avatar reset', () => {
		const nk = stack()
		store(nk, history())
		backfillAll(nk)
		writeProfile(nk as any, A, {
			...defaultProfile(A),
			preferredJoker: 'j_baron',
		})
		const before = readProgress(nk as any, A)
		let cursor = ''
		do
			cursor = JSON.parse(
				rpcAdminAvatarsReset(
					serverCtx(),
					fakeLogger,
					nk as any,
					JSON.stringify({ cursor }),
				),
			).cursor
		while (cursor !== '')
		expect(readProgress(nk as any, A)).toEqual(before)
		expect(readProfile(nk as any, A)!.profile.preferredJoker).toBe('j_baron')
	})

	it('is server-only', () => {
		expect(() =>
			rpcAdminAchievementsBackfill(
				{ ...serverCtx(), userId: A } as any,
				fakeLogger,
				stack() as any,
				'{}',
			),
		).toThrow()
	})
})
