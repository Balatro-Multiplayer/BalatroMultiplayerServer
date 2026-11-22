import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Run } from '../core/types'
import { type Report, pvpBlindOf, runFor, withLives } from '../testing/view'
import { duelLosers, duelMode, duelOpponents } from './duel'

// A duel mid-PvP blind: both still in the lobby, each side's report as given.
function playing(first: Report, second: Report) {
	return {
		run: runFor('nemesis', ['a', 'b']),
		currentPvpBlind: pvpBlindOf({ a: first, b: second }),
	}
}

describe('losersOf', () => {
	it.each<[string, Report, Report, string[] | null]>([
		[
			'trailing player out of hands loses',
			{ score: '5', handsLeft: 0 },
			{ score: '9', handsLeft: 2 },
			['a'],
		],
		[
			'the other side trails and is out',
			{ score: '9', handsLeft: 2 },
			{ score: '5', handsLeft: 0 },
			['b'],
		],
		[
			'the leader out of hands waits on the trailer',
			{ score: '9', handsLeft: 0 },
			{ score: '5', handsLeft: 1 },
			null,
		],
		[
			'both out, higher wins',
			{ score: '9', handsLeft: 0 },
			{ score: '5', handsLeft: 0 },
			['b'],
		],
		[
			'both out, an exact tie loses nobody',
			{ score: '7', handsLeft: 0 },
			{ score: '7', handsLeft: 0 },
			[],
		],
		[
			'server-spent hands count as done',
			{ score: '1', handsLeft: 3, handsUsedUp: true },
			{ score: '4', handsLeft: 2 },
			['a'],
		],
		[
			'nobody out of hands',
			{ score: '1', handsLeft: 2 },
			{ score: '4', handsLeft: 2 },
			null,
		],
		[
			'one side has not reported',
			{ handsLeft: null },
			{ score: '4', handsLeft: 0 },
			null,
		],
	])('%s', (_name, first, second, losers) => {
		const { run, currentPvpBlind } = playing(first, second)
		expect(duelMode.losersOf(run, currentPvpBlind)).toEqual(losers)
		expect(duelLosers(run, currentPvpBlind)).toEqual(losers)
	})

	// A PvP blind's loser loses one life (the ledger's job); here a plain stand-in, so the
	// properties are about the mode's rules only.
	function loseLife(run: Run, losers: string[]): Run {
		const changes: { [id: string]: { lives: number; eliminated: boolean } } = {}
		for (const id of losers) {
			const lives = run.lives[id].lives - 1
			changes[id] = { lives, eliminated: lives <= 0 }
		}
		return withLives(run, changes)
	}

	it('a long duel: lives stay at or above 0, one life per PvP blind, the ending is a win once a player is out', () => {
		const text = fc.nat({ max: 10_000 }).map(String)
		fc.assert(
			fc.property(
				fc.array(fc.tuple(text, text), { minLength: 1, maxLength: 30 }),
				(finishedPvpBlinds) => {
					let run = runFor('nemesis', ['a', 'b'], { starting_lives: 3 })
					for (const [first, second] of finishedPvpBlinds) {
						if (duelMode.checkWinner(run) !== null) break
						const currentPvpBlind = pvpBlindOf({
							a: { score: first, handsLeft: 0 },
							b: { score: second, handsLeft: 0 },
						})
						const before = run.lives.a.lives + run.lives.b.lives
						run = loseLife(run, duelMode.losersOf(run, currentPvpBlind) ?? [])
						const after = run.lives.a.lives + run.lives.b.lives
						expect(before - after).toBeLessThanOrEqual(1)
						expect(run.lives.a.lives).toBeGreaterThanOrEqual(0)
						expect(run.lives.b.lives).toBeGreaterThanOrEqual(0)
						const out = ['a', 'b'].filter((id) => run.lives[id].lives <= 0)
						if (out.length === 1)
							expect(duelMode.checkWinner(run)?.winners).toEqual(
								['a', 'b'].filter((id) => !out.includes(id)),
							)
					}
				},
			),
		)
	})

	it('does nothing without two alive in the PvP blind', () => {
		const done = { score: '1', handsLeft: 0 }
		const shop = playing(done, done)
		const dead = withLives(shop.run, { b: { lives: 0 } })
		expect(duelMode.losersOf(dead, shop.currentPvpBlind)).toBeNull()
		const alone = {
			...shop.currentPvpBlind,
			players: { a: shop.currentPvpBlind.players.a },
		}
		expect(duelMode.losersOf(shop.run, alone)).toBeNull()
	})
})

describe('opponents and the mode contract', () => {
	it('each player targets the other; alone targets no one', () => {
		const { run } = playing({}, {})
		expect(duelOpponents(['a', 'b'])).toEqual({ a: 'b', b: 'a' })
		expect(duelOpponents(['a'])).toEqual({ a: null })
		expect(duelMode.view(run, null)).toEqual({ opponents: { a: 'b', b: 'a' } })
	})

	it('waits a last life on the opponent', () => {
		expect(duelMode.name).toBe('duel')
		expect(duelMode.deathWaitsOn).toBe('opponent')
	})
})
