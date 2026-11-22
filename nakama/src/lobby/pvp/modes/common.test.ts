import { describe, expect, it } from 'vitest'
import type { Run } from '../core/types'
import type { PvpLifePlayer } from '../rules/lives'
import { settingsAtStart, withRules } from '../testing/rules'
import {
	type Report,
	lifePlayer,
	pvpBlindOf,
	runFor,
	withLives,
} from '../testing/view'
import {
	aliveIds,
	aliveInPvpBlind,
	allOutOfHands,
	hasNotReported,
	highestAnte,
	lastPlayerStanding,
	latestPairing,
	pairingOfAnte,
	scoreOf,
	startingLives,
} from './common'

// A running nemesis run with the given player overrides.
function game(
	playersById: { [id: string]: Partial<PvpLifePlayer> } = {},
	ids: string[] = ['a', 'b'],
): Run {
	return withLives(runFor('nemesis', ids), playersById)
}

describe('who is alive', () => {
	it('aliveIds drops a player who left, forfeited, is out or has no lives, in id order', () => {
		const run = game(
			{
				a: { status: 'left' },
				b: { lives: 0 },
				c: { status: 'out' },
				d: { status: 'forfeited' },
			},
			['e', 'a', 'b', 'c', 'd', 'f'],
		)
		expect(aliveIds(run)).toEqual(['e', 'f'])
	})

	it('aliveInPvpBlind counts only the players the PvP blind started with', () => {
		const run = game({ b: { lives: 0 } }, ['a', 'b', 'c'])
		const currentPvpBlind = pvpBlindOf({ b: {}, a: {} })
		expect(aliveInPvpBlind(run, currentPvpBlind)).toEqual(['a'])
	})
})

describe('reported actions', () => {
	it.each<[string, (number | null)[], number | null]>([
		['nobody has reported', [null, null], null],
		['the highest of the reported', [2, null, 5], 5],
		['one reported', [null, 3], 3],
	])('highestAnte: %s', (_name, antes, expected) => {
		const ids = antes.map((_ante, position) => `p${position}`)
		const base = game({}, ids)
		const players = { ...base.players }
		antes.forEach((ante, position) => {
			players[`p${position}`] = { ...players[`p${position}`], ante }
		})
		expect(highestAnte({ ...base, players })).toBe(expected)
	})

	it('scoreOf is null for no entry and for no score', () => {
		const currentPvpBlind = pvpBlindOf({
			a: { score: '12', handsLeft: 1 },
			c: {},
		})
		expect(scoreOf(currentPvpBlind, 'a')).toBe('12')
		expect(scoreOf(currentPvpBlind, 'c')).toBeNull()
		expect(scoreOf(currentPvpBlind, 'nobody')).toBeNull()
	})

	const hands = (handsLeft: number | null, handsUsedUp = false): Report => ({
		score: '1',
		handsLeft,
		handsUsedUp,
	})
	it.each<[string, Report, boolean]>([
		['at 0 hands', hands(0), true],
		['spent by the server', hands(2, true), true],
		['still has hands', hands(1), false],
		['an unknown count', hands(null), false],
	])('allOutOfHands: b %s, a at 0', (_name, b, expected) => {
		const currentPvpBlind = pvpBlindOf({ a: hands(0), b })
		expect(allOutOfHands(currentPvpBlind, ['a', 'b'])).toBe(expected)
	})

	it('allOutOfHands: a player with no entry is not done', () => {
		expect(allOutOfHands(pvpBlindOf({ a: hands(0) }), ['ghost'])).toBe(false)
	})

	it.each<[string, Report, boolean]>([
		['not entered', {}, true],
		['playing with hands', { score: '3', handsLeft: 2 }, false],
		['done', { score: '3', handsLeft: 0 }, false],
	])('hasNotReported: %s', (_name, report, expected) => {
		expect(hasNotReported(pvpBlindOf({ a: report }), 'a')).toBe(expected)
		expect(hasNotReported(pvpBlindOf({}), 'a')).toBe(true)
	})
})

describe('pairings', () => {
	const pairing = (ante: number) => ({
		ante,
		partners: {},
		usedPairs: [],
		lastBye: null,
	})

	it('pairingOfAnte is the pairing of that ante, null for none or no ante', () => {
		const run = { ...game(), pairings: { 2: pairing(2) } }
		expect(pairingOfAnte(run, 2)).toBe(run.pairings[2])
		expect(pairingOfAnte(run, 3)).toBeNull()
		expect(pairingOfAnte(run, null)).toBeNull()
	})

	it('latestPairing is the highest ante paired, null while nobody is paired', () => {
		expect(latestPairing(game())).toBeNull()
		const run = { ...game(), pairings: { 2: pairing(2), 10: pairing(10) } }
		expect(latestPairing(run)).toBe(run.pairings[10])
	})
})

describe('startingLives', () => {
	it('gives every started player the starting lives, in id order', () => {
		const rules = settingsAtStart(withRules({ queue_mode: 'pvp_nemesis' }), [
			'b',
			'a',
		])
		const out = startingLives(rules, {
			startedIds: ['b', 'a'],
			picks: {},
			teamPlan: null,
		})
		expect(Object.keys(out)).toEqual(['a', 'b'])
		expect(out.a).toEqual(lifePlayer({ lives: rules.startingLives }))
	})
})

describe('lastPlayerStanding', () => {
	it('names the survivor the winner, the rest second', () => {
		const out = lastPlayerStanding(
			game({ b: { status: 'out' }, c: { lives: 0 } }, ['a', 'b', 'c']),
		)
		expect(out).toEqual({
			winners: ['a'],
			places: { a: 1, b: 2, c: 2 },
		})
	})

	it('no one alive is a draw with everyone first', () => {
		const out = lastPlayerStanding(
			game({ a: { status: 'out' }, b: { lives: 0 } }),
		)
		expect(out).toEqual({ winners: null, places: { a: 1, b: 1 } })
	})

	it('waits with two alive', () => {
		expect(lastPlayerStanding(game())).toBeNull()
	})
})
