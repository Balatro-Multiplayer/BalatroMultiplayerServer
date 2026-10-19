import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { NotifyCode } from '../notify'
import { defaultProfile, writeProfile } from '../player/profile'
import { A, B, C, runOf } from '../testing/achievement_fixtures'
import { fakeLogger, fakeNk, type FakeNk } from '../testing/fake_nk'
import { closing, eventsFrom, play, pvpOpening, spdrnOpening, type Tuple } from '../testing/replay_fixtures'
import { recordMilestone, recordRun } from './record'
import { progressFor, writeProgress } from './storage'
import { emptyProgress } from './progress'

function stack(enabled = true): FakeNk {
	const nk = fakeNk()
	writeConfig(nk as any, { ...DEFAULT_CONFIG, achievementsEnabled: enabled })
	for (const id of [A, B, C]) writeProfile(nk as any, id, defaultProfile(id))
	return nk
}

function hands(n: number, from = 100): Tuple[] {
	return Array.from({ length: n }, (_, i) => play(from + i * 1000, 10 + i * 2))
}

const pvpLog = (result: 'win' | 'loss') => eventsFrom([...pvpOpening('Blue Deck'), ...hands(4), ...closing(9000, result)])
const unlocks = (nk: FakeNk, userId: string) => nk.notifications.filter((n) => n.userId === userId && n.code === NotifyCode.AVATAR_UNLOCKED)

describe('recordRun', () => {
	it('counts the game for every player and announces what each earned', () => {
		const nk = stack()
		recordRun(nk as any, fakeLogger, runOf(), { [A]: pvpLog('win'), [B]: pvpLog('loss') })
		const a = progressFor(nk as any, A)
		expect(a.counters).toMatchObject({ games: 1, wins: 1, pvpGames: 1, hands: 4, daysPlayed: 1 })
		expect(a.deckGames).toEqual({ b_blue: 1 })
		expect(a.unlocked).toEqual(['j_baron'])
		expect(progressFor(nk as any, B).counters).toMatchObject({ games: 1, wins: 0 })
		expect(unlocks(nk, A)).toEqual([
			{ userId: A, subject: 'avatar_unlocked', content: { avatarIds: ['j_baron'], runId: 'run-1' }, code: 107, persistent: true },
		])
		expect(unlocks(nk, B)).toEqual([])
	})

	it('counts a run once', () => {
		const nk = stack()
		const logs = { [A]: pvpLog('win'), [B]: pvpLog('loss') }
		recordRun(nk as any, fakeLogger, runOf(), logs)
		recordRun(nk as any, fakeLogger, runOf(), logs)
		expect(progressFor(nk as any, A).counters.games).toBe(1)
		expect(unlocks(nk, A)).toHaveLength(1)
	})

	it('does nothing while achievements are off', () => {
		const nk = stack(false)
		recordRun(nk as any, fakeLogger, runOf(), { [A]: pvpLog('win'), [B]: pvpLog('loss') })
		expect(progressFor(nk as any, A).counters.games).toBe(0)
		expect(nk.notifications).toEqual([])
	})

	it('skips a flagged player but still counts the others', () => {
		const nk = stack()
		recordRun(nk as any, fakeLogger, runOf({ flags: { [A]: 'hash_mismatch' } }), { [A]: pvpLog('win'), [B]: pvpLog('loss') })
		expect(progressFor(nk as any, A).counters.games).toBe(0)
		expect(progressFor(nk as any, B).counters.games).toBe(1)
	})

	it('earns Showman for meeting a player showing it', () => {
		const nk = stack()
		const run = runOf({
			players: [{ id: A, displayName: 'A' }, { id: B, displayName: 'B', avatar: 'j_ring_master' }],
			placements: [{ playerId: B, place: 1 }, { playerId: A, place: 2 }],
		})
		recordRun(nk as any, fakeLogger, run, { [A]: pvpLog('loss'), [B]: pvpLog('win') })
		expect(progressFor(nk as any, A).unlocked).toEqual(['j_ring_master'])
		expect(progressFor(nk as any, B).unlocked).toEqual(['j_baron'])
	})

	it('counts the Speedrun mode from the server options', () => {
		const nk = stack()
		const log = eventsFrom([...spdrnOpening('spdrn_seed_scout', 'b_green'), ...hands(4, 3000), ...closing(9000, 'win')])
		const run = runOf({ modId: 'MultiplayerSPDRN', options: { gamemode: 'spdrn_challenge' } })
		recordRun(nk as any, fakeLogger, run, { [A]: log, [B]: log })
		const a = progressFor(nk as any, A)
		expect(a.counters.spdrnGames).toBe(1)
		expect(a.spdrnModesPlayed).toEqual(['spdrn_challenge'])
		expect(a.deckGames).toEqual({ b_green: 1 })
	})

	it('crosses a goal a player was set just short of', () => {
		const nk = stack()
		const near = emptyProgress()
		near.counters.games = 4
		near.counters.wins = 1
		near.unlocked = ['j_baron']
		writeProgress(nk as any, A, near)
		recordRun(nk as any, fakeLogger, runOf(), { [A]: pvpLog('win'), [B]: pvpLog('loss') })
		expect(unlocks(nk, A).map((n) => n.content.avatarIds)).toEqual([['j_swashbuckler']])
	})

	it('keeps going when one player fails', () => {
		const nk = stack()
		const write = nk.storageWrite
		nk.storageWrite = (writes: any[]) => {
			if (writes.some((w) => w.userId === A)) throw new Error('db down')
			return write(writes)
		}
		recordRun(nk as any, fakeLogger, runOf(), { [A]: pvpLog('win'), [B]: pvpLog('loss') })
		expect(progressFor(nk as any, B).counters.games).toBe(1)
	})
})

describe('recordMilestone', () => {
	it('earns Scholar once for linking Discord', () => {
		const nk = stack()
		recordMilestone(nk as any, fakeLogger, A, 'discordLinked', [])
		recordMilestone(nk as any, fakeLogger, A, 'discordLinked', [])
		expect(progressFor(nk as any, A).unlocked).toEqual(['j_scholar'])
		expect(unlocks(nk, A).map((n) => n.content)).toEqual([{ avatarIds: ['j_scholar'], runId: null }])
	})

	it('does nothing while achievements are off', () => {
		const nk = stack(false)
		recordMilestone(nk as any, fakeLogger, A, 'discordLinked', [])
		expect(progressFor(nk as any, A).milestones).toEqual([])
	})
})
