import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { defaultProfile, writeProfile } from '../player/profile'
import { A, B } from '../testing/achievement_fixtures'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from '../testing/fake_nk'
import { emptyProgress } from './progress'
import { editedProgress, rpcAdminAvatarsFor, rpcAdminProgressSet, rpcAvatarCatalog } from './rpc'
import { PROGRESS_COLLECTION, PROGRESS_KEY, progressFor, writeProgress } from './storage'

const TESTING = { BMP_SERVER_KIND: 'dev' }

function stack() {
	const nk = fakeNk()
	writeConfig(nk as any, { ...DEFAULT_CONFIG, achievementsEnabled: true })
	writeProfile(nk as any, A, { ...defaultProfile('A'), preferredJoker: 'j_baron', privileges: ['bean'] })
	const progress = emptyProgress()
	progress.counters.wins = 3
	progress.unlocked = ['j_baron']
	writeProgress(nk as any, A, progress)
	return nk
}

const avatar = (view: any, id: string) => view.avatars.find((a: any) => a.id === id)

describe('avatar_catalog', () => {
	it("lists every avatar with the player's locks and goals", () => {
		const view = JSON.parse(rpcAvatarCatalog(playerCtx(A), fakeLogger, stack() as any, '{}'))
		expect(view.avatars).toHaveLength(63)
		expect(view.selected).toBe('j_baron')
		expect(view.enabled).toBe(true)
		expect(avatar(view, 'j_joker')).toEqual({ id: 'j_joker', unlocked: true, goal: null })
		expect(avatar(view, 'j_baron')).toMatchObject({ unlocked: true })
		expect(avatar(view, 'j_turtle_bean')).toMatchObject({ unlocked: true })
		expect(avatar(view, 'j_lucky_cat')).toEqual({ id: 'j_lucky_cat', unlocked: false, goal: { kind: 'counter', key: 'wins', threshold: 10, progress: 3 } })
	})

	it('needs a player', () => {
		expect(() => rpcAvatarCatalog(serverCtx(), fakeLogger, stack() as any, '{}')).toThrow()
	})
})

describe('admin_avatars_for', () => {
	it("answers for a player's account", () => {
		const view = JSON.parse(rpcAdminAvatarsFor(serverCtx(), fakeLogger, stack() as any, JSON.stringify({ userId: A })))
		expect(view.jokers).toContain('j_baron')
		expect(view.jokers).toContain('j_turtle_bean')
		expect(view.jokers).not.toContain('j_mime')
		expect(view.jokers).toHaveLength(13)
	})

	it('answers from privileges for a player with no account', () => {
		const view = JSON.parse(rpcAdminAvatarsFor(serverCtx(), fakeLogger, stack() as any, JSON.stringify({ privileges: ['staff'] })))
		expect(view.selected).toBe('j_joker')
		expect(view.jokers.slice(11)).toEqual(['j_ring_master', 'j_mime'])
	})

	it('rejects bad input, unknown players and players', () => {
		const nk = stack()
		const call = (input: object, ctx = serverCtx()) => () => rpcAdminAvatarsFor(ctx, fakeLogger, nk as any, JSON.stringify(input))
		expect(call({ userId: 'x' })).toThrow(/Invalid userId/)
		expect(call({ userId: B })).toThrow(/No such player/)
		expect(call({})).toThrow(/required/)
		expect(call({ privileges: ['bad space'] })).toThrow(/required/)
		expect(call({ userId: A }, playerCtx(A))).toThrow()
	})
})

describe('admin_progress_set', () => {
	it('only exists on a testing server', () => {
		expect(() => rpcAdminProgressSet(serverCtx(), fakeLogger, stack() as any, JSON.stringify({ userId: A }))).toThrow(/Testing RPCs are off/)
	})

	it('sets fields, merging counters and decks, and earns nothing itself', () => {
		const nk = stack()
		const set = (input: object) => JSON.parse(rpcAdminProgressSet(serverCtx(TESTING), fakeLogger, nk as any, JSON.stringify({ userId: A, ...input }))).progress
		const p = set({ counters: { games: 4, bestWinStreak: 2 }, deckGames: { b_blue: 9 } })
		expect(p.counters).toMatchObject({ wins: 3, games: 4 })
		expect(p.winStreak).toEqual({ current: 0, best: 2 })
		expect(p.deckGames).toEqual({ b_blue: 9 })
		expect(p.unlocked).toEqual(['j_baron'])
		expect(nk.notifications).toEqual([])
		const fresh = set({ reset: true, spdrnModesPlayed: ['spdrn_challenge'], milestones: ['metShowman'] })
		expect(fresh.counters.wins).toBe(0)
		expect(fresh.unlocked).toEqual([])
		expect(progressFor(nk as any, A).spdrnModesPlayed).toEqual(['spdrn_challenge'])
	})

	it('rejects malformed edits', () => {
		const p = emptyProgress()
		expect(() => editedProgress(p, { counters: { bogus: 1 } })).toThrow(/Invalid counter bogus/)
		expect(() => editedProgress(p, { counters: { wins: -1 } })).toThrow(/Invalid counter wins/)
		expect(() => editedProgress(p, { counters: [] })).toThrow(/counters must be an object/)
		expect(() => editedProgress(p, { deckGames: { b_challenge: 1 } })).toThrow(/Invalid deck/)
		expect(() => editedProgress(p, { spdrnModesPlayed: ['nope'] })).toThrow(/spdrnModesPlayed/)
		expect(() => editedProgress(p, { milestones: ['nope'] })).toThrow(/milestones/)
		expect(() => editedProgress(p, { unlocked: ['j_nope'] })).toThrow(/unlocked/)
		expect(() => rpcAdminProgressSet(serverCtx(TESTING), fakeLogger, stack() as any, JSON.stringify({ userId: 'x' }))).toThrow(/Invalid userId/)
	})

	it('refuses an unknown player and writes nothing', () => {
		const nk = stack()
		expect(() => rpcAdminProgressSet(serverCtx(TESTING), fakeLogger, nk as any, JSON.stringify({ userId: B, counters: { wins: 1 } }))).toThrow(/No such player/)
		expect(nk.storageRead([{ collection: PROGRESS_COLLECTION, key: PROGRESS_KEY, userId: B }])).toEqual([])
	})
})
