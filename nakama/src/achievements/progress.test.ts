import { describe, expect, it } from 'vitest'
import { CATALOG } from '../shared/avatars/catalog'
import type { AvatarId } from '../shared/avatars/ids'
import { isEarnedByPlay } from '../shared/avatars/rules'
import { facts } from '../testing/achievement_fixtures'
import { applyGame, emptyProgress, progressOf, utcDayOf, withMilestone, type CountedGame, type Progress } from './progress'
import { goalOf, newlyUnlocked } from './unlocks'


function game(runId: string, over: Partial<CountedGame> = {}): CountedGame {
	return { runId, day: '2026-10-19', kind: 'pvp', result: 'win', activeOpponents: 1, metShowman: false, privateOpponentsKey: null, facts: facts(), ...over }
}

const play = (progress: Progress, games: CountedGame[]) => games.reduce(applyGame, progress)

describe('progress', () => {
	it('counts a game once', () => {
		const once = applyGame(emptyProgress(), game('r1'))
		expect(applyGame(once, game('r1'))).toBe(once)
		expect(once.counters).toMatchObject({ games: 1, wins: 1, pvpGames: 1, spdrnGames: 0, hands: 5, daysPlayed: 1 })
		expect(once.countedRunIds).toEqual(['r1'])
	})

	it('keeps only the latest run ids', () => {
		const many = play(emptyProgress(), Array.from({ length: 70 }, (_, i) => game(`r${i}`)))
		expect(many.countedRunIds).toHaveLength(64)
		expect(many.countedRunIds[63]).toBe('r69')
		expect(many.counters.games).toBe(70)
	})

	it('counts days by UTC date', () => {
		expect(utcDayOf(Date.UTC(2026, 9, 19, 23, 59, 59))).toBe('2026-10-19')
		expect(utcDayOf(Date.UTC(2026, 9, 20, 0, 0, 0))).toBe('2026-10-20')
		const p = play(emptyProgress(), [
			game('a', { day: '2026-10-19' }),
			game('b', { day: '2026-10-19' }),
			game('c', { day: '2026-10-20' }),
			game('d', { day: '2026-10-22' }),
		])
		expect(p.counters.daysPlayed).toBe(3)
		expect(p.lastPlayedDay).toBe('2026-10-22')
	})

	it('tracks the win streak; an unknown result leaves it alone', () => {
		const p = play(emptyProgress(), [
			game('1'),
			game('2'),
			game('3', { result: 'unknown' }),
			game('4'),
			game('5', { result: 'loss' }),
			game('6'),
		])
		expect(p.winStreak).toEqual({ current: 1, best: 3 })
		expect(p.counters.wins).toBe(4)
		expect(p.counters.games).toBe(6)
	})

	it('adds the log facts, decks, modes and milestones', () => {
		const p = play(emptyProgress(), [
			game('a', {
				kind: 'spdrn',
				activeOpponents: 7,
				facts: facts({
					rerolls: 3,
					moneySpent: 40,
					suitChangers: 2,
					skips: 4,
					livesLost: 1,
					bestHandScore: 2e11,
					fastestSpdrnRunMs: 7 * 60 * 1000,
					setup: { decks: ['b_ghost', 'b_blue'], smallworld: true, spdrnMode: 'spdrn_seed_scout' },
				}),
			}),
			game('b', { kind: 'pvp', activeOpponents: 3, facts: facts({ setup: { decks: ['b_blue'], smallworld: false, spdrnMode: 'spdrn_challenge' } }) }),
		])
		expect(p.counters).toMatchObject({ rerolls: 3, moneySpent: 40, suitChangers: 2, skips: 4, livesLost: 1, smallworldGames: 1, winsVs3Plus: 2, winsVs7Plus: 1, spdrnGames: 1, pvpGames: 1 })
		expect(p.deckGames).toEqual({ b_ghost: 1, b_blue: 2 })
		// A mode only counts from a Speedrun game.
		expect(p.spdrnModesPlayed).toEqual(['spdrn_seed_scout'])
		expect(p.milestones.sort()).toEqual(['scoredOver1e11', 'sub8SpdrnRun'])
	})

	it('needs a Speedrun game for the sub-8 milestone, and a met Showman for its own', () => {
		const p = applyGame(emptyProgress(), game('a', { kind: 'pvp', metShowman: true, facts: facts({ fastestSpdrnRunMs: 1000 }) }))
		expect(p.milestones).toEqual(['metShowman'])
	})

	it('reads stored progress defensively', () => {
		expect(progressOf(null)).toEqual(emptyProgress())
		const p = progressOf({ counters: { wins: 3, games: -1, bogus: 9 }, deckGames: { b_red: 2, b_fake: 1 }, unlocked: ['j_baron', 'j_fake'], milestones: ['metShowman', 'x'], spdrnModesPlayed: ['spdrn_challenge', 'x'] })
		expect(p.counters.wins).toBe(3)
		expect(p.counters.games).toBe(0)
		expect(p.deckGames).toEqual({ b_red: 2 })
		expect(p.unlocked).toEqual(['j_baron'])
		expect(p.milestones).toEqual(['metShowman'])
		expect(p.spdrnModesPlayed).toEqual(['spdrn_challenge'])
	})
})

describe('unlocks', () => {
	it('earns what progress meets, once', () => {
		const p = applyGame(emptyProgress(), game('a'))
		expect(newlyUnlocked(p, [])).toEqual(['j_baron'])
		expect(newlyUnlocked({ ...p, unlocked: ['j_baron'] }, [])).toEqual([])
	})

	it('earns every threshold reached at once', () => {
		const p = emptyProgress()
		p.counters.games = 64
		p.counters.wins = 10
		p.winStreak = { current: 5, best: 5 }
		p.deckGames = { b_blue: 10, b_green: 2, b_yellow: 3 }
		expect(newlyUnlocked(p, [])).toEqual([
			'j_baron', 'j_lucky_cat', 'j_swashbuckler', 'j_vampire', 'j_photograph', 'j_square', 'j_fortune_teller', 'j_sixth_sense', 'j_blue_joker', 'j_golden',
		])
	})

	it('earns Idol for every vanilla deck and Hiker for every Speedrun mode', () => {
		const p = emptyProgress()
		for (const deck of ['b_red', 'b_blue', 'b_yellow', 'b_green', 'b_black', 'b_magic', 'b_nebula', 'b_ghost', 'b_abandoned', 'b_checkered', 'b_zodiac', 'b_painted', 'b_anaglyph', 'b_plasma']) p.deckGames[deck] = 1
		p.spdrnModesPlayed = ['spdrn_white_stake_triple', 'spdrn_gold_stake_single', 'spdrn_seed_scout', 'spdrn_challenge', 'spdrn_all_deck']
		expect(newlyUnlocked(p, [])).not.toContain('j_idol')
		expect(goalOf(CATALOG.find((e) => e.id === 'j_idol')!, p, { privileges: [], unlocked: [] })).toEqual({ kind: 'allOf', key: 'vanillaDecks', threshold: 15, progress: 14 })
		p.deckGames.b_erratic = 1
		p.spdrnModesPlayed.push('spdrn_stake_climb')
		expect(newlyUnlocked(p, [])).toEqual(expect.arrayContaining(['j_idol', 'j_hiker']))
	})

	it('earns Pareidolia for every other earnable avatar, never needing reserved or privilege ones', () => {
		const others = CATALOG.filter((e) => isEarnedByPlay(e.rule)).map((e) => e.id)
		const allButShowman = { ...emptyProgress(), unlocked: others.filter((id) => id !== 'j_ring_master') as AvatarId[] }
		expect(newlyUnlocked(allButShowman, [])).toEqual([])
		const pareidolia = CATALOG.find((e) => e.id === 'j_pareidolia')!
		expect(goalOf(pareidolia, allButShowman, { privileges: [], unlocked: allButShowman.unlocked })).toEqual({ kind: 'allUnlockable', key: 'allUnlockable', threshold: 39, progress: 38 })
		// Showman held through staff counts.
		expect(newlyUnlocked(allButShowman, ['staff'])).toEqual(['j_pareidolia'])
		// Earning the last one earns Pareidolia with it.
		const lastOne = withMilestone(allButShowman, 'metShowman')
		expect(newlyUnlocked(lastOne, [])).toEqual(['j_ring_master', 'j_pareidolia'])
	})

	it('describes goals', () => {
		const p = emptyProgress()
		p.counters.wins = 7
		const holdings = { privileges: ['bean'], unlocked: [] }
		const goal = (id: string) => goalOf(CATALOG.find((e) => e.id === id)!, p, holdings)
		expect(goal('j_joker')).toBeNull()
		expect(goal('j_lucky_cat')).toEqual({ kind: 'counter', key: 'wins', threshold: 10, progress: 7 })
		expect(goal('j_baron')).toEqual({ kind: 'counter', key: 'wins', threshold: 1, progress: 1 })
		expect(goal('j_green_joker')).toEqual({ kind: 'deckGames', key: 'b_green', threshold: 3, progress: 0 })
		expect(goal('j_scholar')).toEqual({ kind: 'milestone', key: 'discordLinked', threshold: 1, progress: 0 })
		expect(goal('j_turtle_bean')).toEqual({ kind: 'privilege', key: 'bean', threshold: 1, progress: 1 })
		expect(goal('j_vagabond')).toEqual({ kind: 'privilege', key: 'vagabond', threshold: 1, progress: 0 })
		expect(goal('j_abstract')).toEqual({ kind: 'reserved', key: 'practice', threshold: 1, progress: 0 })
		expect(goal('j_sixth_sense')).toEqual({ kind: 'counter', key: 'bestWinStreak', threshold: 5, progress: 0 })
	})
})
