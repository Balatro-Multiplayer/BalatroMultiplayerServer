import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareBlindScore } from '../core/score'
import { pvpBlindOf, runFor, withLives } from '../testing/view'
import { rankRoyale, royaleMode } from './royale'

const entries = (scores: (string | null)[]) =>
	scores.map((score, i) => ({ id: `p${i}`, score }))

// A royale PvP blind: every id has a score and hands left (0 means out of hands).
function playing(
	scores: { [id: string]: [string | null, number | null] },
	lives: { [id: string]: number } = {},
) {
	const ids = Object.keys(scores)
	const reports: Parameters<typeof pvpBlindOf>[0] = {}
	const changes: { [id: string]: { lives: number } } = {}
	for (const id of ids) {
		reports[id] = { score: scores[id][0], handsLeft: scores[id][1] }
		if (lives[id] !== undefined) changes[id] = { lives: lives[id] }
	}
	return {
		run: withLives(runFor('royale', ids), changes),
		currentPvpBlind: pvpBlindOf(reports),
	}
}

describe('rankRoyale', () => {
	it.each<[string, (string | null)[], string[]]>([
		['three: the bottom player is cut', ['1', '5', '9'], ['p0']],
		['four: the bottom two are cut', ['1', '2', '8', '9'], ['p0', 'p1']],
		[
			'a tie at the cut is cut together',
			['1', '1', '1', '9'],
			['p0', 'p1', 'p2'],
		],
		['all tied: nobody loses', ['5', '5', '5'], []],
		['unreported ranks below every score', [null, '0', '3'], ['p0']],
		['the cut at the top moves under the top', ['2', '9', '9'], ['p0']],
		['two players: the lower loses', ['3', '8'], ['p0']],
		['two tied: nobody loses', ['3', '3'], []],
		['one player alone is all tied', ['3'], []],
		['no players', [], []],
	])('%s', (_name, scores, losers) => {
		expect(rankRoyale(entries(scores)).losers).toEqual(losers)
	})

	it('ranks ascending, ties by id, whatever the input order', () => {
		const all = entries(['9', '1', '5', '5'])
		const want = ['p1', 'p2', 'p3', 'p0']
		expect(rankRoyale(all).ranked).toEqual(want)
		expect(rankRoyale([...all].reverse()).ranked).toEqual(want)
		expect(rankRoyale([...all].reverse()).losers).toEqual(
			rankRoyale(all).losers,
		)
	})

	describe('properties over 3 to 8 players', () => {
		// A small range so ties are common; some scores are arrays ("20,1" is 10^20).
		const scoreText = fc.oneof(
			fc.nat({ max: 20 }).map(String),
			fc.integer({ min: 20, max: 24 }).map((n) => `${n},1`),
			fc.constant(null),
		)
		const field = fc.array(scoreText, { minLength: 3, maxLength: 8 })
		const ranks = (first: string | null, second: string | null) =>
			compareBlindScore(first, second)

		it('the top scorer never loses and someone survives', () => {
			fc.assert(
				fc.property(field, (scores) => {
					const { ranked, losers } = rankRoyale(entries(scores))
					expect(losers).not.toContain(ranked[ranked.length - 1])
					expect(losers.length).toBeLessThan(ranked.length)
					expect(ranked.filter((id) => losers.includes(id))).toEqual(losers)
				}),
			)
		})

		it('someone loses unless all tie, and at least half lose when the cut is below the top', () => {
			fc.assert(
				fc.property(field, (scores) => {
					const { losers } = rankRoyale(entries(scores))
					const ascending = [...scores].sort(ranks)
					const top = ascending[ascending.length - 1]
					const half = Math.max(1, Math.floor(scores.length / 2))
					if (ranks(ascending[0], top) !== 0)
						expect(losers.length).toBeGreaterThanOrEqual(1)
					if (ranks(top, ascending[half - 1]) > 0)
						expect(losers.length).toBeGreaterThanOrEqual(half)
				}),
			)
		})

		it('every loser scores no more than every survivor', () => {
			fc.assert(
				fc.property(field, (scores) => {
					const all = entries(scores)
					const { losers } = rankRoyale(all)
					const lost = all.filter((entry) => losers.includes(entry.id))
					const kept = all.filter((entry) => !losers.includes(entry.id))
					for (const loser of lost)
						for (const survivor of kept)
							expect(ranks(loser.score, survivor.score)).toBeLessThanOrEqual(0)
				}),
			)
		})

		it('input order does not change the result', () => {
			fc.assert(
				fc.property(
					field.chain((scores) =>
						fc.tuple(
							fc.constant(entries(scores)),
							fc.shuffledSubarray(entries(scores), {
								minLength: scores.length,
								maxLength: scores.length,
							}),
						),
					),
					([inOrder, shuffled]) => {
						expect(rankRoyale(shuffled)).toEqual(rankRoyale(inOrder))
					},
				),
			)
		})
	})
})

describe('losersOf', () => {
	const losersOf = (input: ReturnType<typeof playing>) =>
		royaleMode.losersOf(input.run, input.currentPvpBlind)

	it('ranks and cuts once every alive player is out of hands', () => {
		expect(
			losersOf(playing({ a: ['1', 0], b: ['5', 0], c: ['9', 0] })),
		).toEqual(['a'])
	})

	it('waits while anyone alive still has hands or has not reported', () => {
		for (const waiting of [
			playing({ a: ['1', 0], b: ['5', 0], c: ['9', 1] }),
			playing({ a: ['1', 0], b: ['5', 0], c: [null, null] }),
		])
			expect(losersOf(waiting)).toBeNull()
	})

	it('never ranks or waits for the dead', () => {
		expect(
			losersOf(playing({ a: ['1', 0], b: ['5', 0], c: ['0', 4] }, { c: 0 })),
		).toEqual(['a'])
	})

	it('does nothing with fewer than two alive', () => {
		expect(losersOf(playing({ a: ['1', 0], b: ['5', 0] }, { b: 0 }))).toBeNull()
	})

	it('an unreported score ranks below every reported one', () => {
		expect(
			losersOf(playing({ a: ['100', 0], b: ['200', 0], c: [null, 0] })),
		).toEqual(['c'])
	})

	it('compares scores as score text, not as numbers', () => {
		expect(
			losersOf(
				playing({ a: ['12', 0], b: ['9007199254740991', 0], c: ['20,1', 0] }),
			),
		).toEqual(['a'])
	})

	it('a tie of everyone costs nobody', () => {
		expect(
			losersOf(playing({ a: ['4', 0], b: ['4', 0], c: ['4', 0] })),
		).toEqual([])
	})
})

describe('view', () => {
	const view = (input: ReturnType<typeof playing>) =>
		royaleMode.view(input.run, null)

	it('shows no score: everyone is below the cut and targets the next id', () => {
		expect(view(playing({ a: ['1', 1], b: ['5', 1], c: ['9', 1] }))).toEqual({
			opponents: { a: 'b', b: 'c', c: null },
			cut: { a: 'below the cut', b: 'below the cut', c: 'below the cut' },
		})
	})

	it('the targets do not depend on the scores', () => {
		const tied = view(playing({ a: ['9', 1], b: ['9', 1], c: ['9', 1] }))
		const apart = view(playing({ a: ['1', 1], b: ['5', 1], c: ['9', 1] }))
		expect(tied).toEqual(apart)
	})

	it('two alive after a start of 3 or more still rank by id', () => {
		expect(view(playing({ a: ['100', 1], b: ['200', 1] }))).toEqual({
			opponents: { a: 'b', b: null },
			cut: { a: 'below the cut', b: 'below the cut' },
		})
	})

	it('shows nothing below two alive', () => {
		expect(view(playing({ a: ['1', 1], b: ['5', 1] }, { b: 0 }))).toEqual({
			opponents: {},
			cut: {},
		})
	})
})

describe('the mode contract', () => {
	it('waits a death on everyone', () => {
		expect(royaleMode.name).toBe('royale')
		expect(royaleMode.deathWaitsOn).toBe('everyone')
	})
})
