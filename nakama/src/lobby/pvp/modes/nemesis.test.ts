import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Run } from '../core/types'
import { pvpBlindOf, runFor, scriptedRandom, withLives } from '../testing/view'
import { pairsForAnte, nemesisMode, pairNemesis, shuffled } from './nemesis'
import type { PvpPairing } from './types'

const ids = (count: number): string[] =>
	Array.from({ length: count }, (_v, i) => String.fromCharCode(97 + i))

const key = (first: string, second: string): string =>
	first < second ? `${first}|${second}` : `${second}|${first}`

// A deterministic spread of random sources, one per seed.
const DRAWS = [0.13, 0.71, 0.42, 0.88, 0.05, 0.57]
const seededRandom = (seed: number) =>
	scriptedRandom([...DRAWS.slice(seed % 6), ...DRAWS.slice(0, seed % 6)])
const SEEDS = [0, 1, 2, 3, 4, 5]
const SIZES = [2, 3, 4, 5, 6, 7, 8]
const drawOf = fc.double({ min: 0, max: 0.999, noNaN: true })

describe('shuffled', () => {
	it('is a permutation, and the identity under a draw of 0.99', () => {
		for (const count of SIZES) {
			const out = shuffled(ids(count), seededRandom(count))
			expect([...out].sort()).toEqual(ids(count))
			expect(shuffled(ids(count), () => 0.99)).toEqual(ids(count))
		}
	})

	it('does not touch its input', () => {
		const input = ids(4)
		shuffled(input, () => 0)
		expect(input).toEqual(ids(4))
	})
})

describe('pairsForAnte', () => {
	it('keeps the first id fixed and pairs everyone once', () => {
		for (const count of [2, 4, 6, 8])
			for (let offset = 0; offset <= count - 2; offset++) {
				const pairs = pairsForAnte(ids(count), offset)
				expect(pairs).toHaveLength(count / 2)
				expect(pairs.flat().sort()).toEqual(ids(count))
				expect(pairs[0][0]).toBe('a')
			}
	})

	it('rotates four ids through every opponent of a', () => {
		const partners = [0, 1, 2].map((o) => pairsForAnte(ids(4), o)[0][1])
		expect([...partners].sort()).toEqual(['b', 'c', 'd'])
	})
})

describe('pairNemesis', () => {
	it('pairs everyone symmetrically, the odd one out gets the bye', () => {
		for (const count of SIZES)
			for (const seed of SEEDS) {
				const pairedUp = pairNemesis(ids(count), null, 1, seededRandom(seed))
				expect(Object.keys(pairedUp.partners).sort()).toEqual(ids(count))
				const byes = ids(count).filter((id) => pairedUp.partners[id] === null)
				expect(byes).toHaveLength(count % 2)
				expect(pairedUp.lastBye).toBe(byes[0] ?? null)
				for (const id of ids(count)) {
					const partner = pairedUp.partners[id]
					if (partner !== null) {
						expect(partner).not.toBe(id)
						expect(pairedUp.partners[partner]).toBe(id)
					}
				}
			}
	})

	it('is the same pairing for the same draw, whatever the input order', () => {
		const first = pairNemesis(ids(5), null, 1, seededRandom(3))
		const second = pairNemesis([...ids(5)].reverse(), null, 1, seededRandom(3))
		expect(second).toEqual(first)
	})

	it('records the pairs played and the ante', () => {
		const pairedUp = pairNemesis(ids(4), null, 3, seededRandom(1))
		expect(pairedUp.ante).toBe(3)
		expect(pairedUp.usedPairs).toHaveLength(2)
		for (const id of ids(4))
			expect(pairedUp.usedPairs).toContain(key(id, pairedUp.partners[id] ?? id))
	})

	// Four players over three antes meet every opponent once: all 6 pairs, none twice.
	it('4 alive: three antes use all 6 pairs, none twice', () => {
		fc.assert(
			fc.property(
				fc.array(drawOf, { minLength: 3, maxLength: 3 }),
				(anteDraws) => {
					let previousPairing: PvpPairing | null = null
					const seen = new Set<string>()
					anteDraws.forEach((draw, index) => {
						const pairedUp: PvpPairing = pairNemesis(
							ids(4),
							previousPairing,
							index + 1,
							() => draw,
						)
						for (const id of ids(4)) {
							const partner = pairedUp.partners[id]
							if (partner !== null && id < partner) {
								expect(seen.has(key(id, partner))).toBe(false)
								seen.add(key(id, partner))
							}
						}
						previousPairing = pairedUp
					})
					expect(seen.size).toBe(6)
				},
			),
		)
	})

	// A pair plays again only after every rotation had repeated one and the used
	// pairs started over.
	it('a repeat happens only after a reset', () => {
		fc.assert(
			fc.property(
				fc.array(drawOf, { minLength: 1, maxLength: 10 }),
				(anteDraws) => {
					let previousPairing: PvpPairing | null = null
					anteDraws.forEach((draw, index) => {
						const pairedUp: PvpPairing = pairNemesis(
							ids(4),
							previousPairing,
							index + 1,
							() => draw,
						)
						const before = new Set(previousPairing?.usedPairs ?? [])
						const chosen = pairedUp.usedPairs.slice(-2)
						if (chosen.some((pair) => before.has(pair))) {
							// Four players have three ways to pair up; all three had a used pair.
							for (const matching of [
								['a|b', 'c|d'],
								['a|c', 'b|d'],
								['a|d', 'b|c'],
							])
								expect(matching.some((pair) => before.has(pair))).toBe(true)
							expect(pairedUp.usedPairs).toEqual(chosen)
						} else {
							expect(pairedUp.usedPairs).toEqual([...before, ...chosen])
						}
						previousPairing = pairedUp
					})
				},
			),
		)
	})

	it('starts the used pairs over when every rotation repeats one', () => {
		const used = ['a|b', 'a|c', 'a|d', 'c|d', 'b|d', 'b|c']
		const previousPairing: PvpPairing = {
			ante: 3,
			partners: {},
			usedPairs: used,
			lastBye: null,
		}
		const pairedUp = pairNemesis(ids(4), previousPairing, 4, seededRandom(0))
		expect(pairedUp.usedPairs).toHaveLength(2)
	})

	it('byes someone other than last ante’s bye', () => {
		for (const seed of SEEDS) {
			const previousPairing: PvpPairing = {
				ante: 1,
				partners: {},
				usedPairs: [],
				lastBye: 'a',
			}
			expect(
				pairNemesis(ids(3), previousPairing, 2, seededRandom(seed)).lastBye,
			).not.toBe('a')
		}
	})

	it('pairs nobody below two players', () => {
		for (const alive of [[], ['a']]) {
			const previousPairing: PvpPairing = {
				ante: 1,
				partners: {},
				usedPairs: ['a|b'],
				lastBye: 'c',
			}
			expect(pairNemesis(alive, previousPairing, 2, seededRandom(0))).toEqual({
				ante: 2,
				partners: {},
				usedPairs: ['a|b'],
				lastBye: 'c',
			})
		}
	})
})

// A running nemesis game with each player's ante / score / hands as reported, and the
// pairing stored for its ante. The PvP blind is the one of that ante.
function game(
	reports: { [id: string]: { ante?: number; score?: string; hands?: number } },
	pairing: PvpPairing | null = null,
	lives: { [id: string]: number } = {},
) {
	const names = Object.keys(reports)
	const base = runFor('nemesis', names)
	const changes: { [id: string]: { lives: number } } = {}
	const players: Run['players'] = {}
	const currentPvpBlind: Parameters<typeof pvpBlindOf>[0] = {}
	for (const id of names) {
		const report = reports[id]
		players[id] = { ...base.players[id], ante: report.ante ?? null }
		currentPvpBlind[id] = {
			score: report.score ?? null,
			handsLeft: report.hands ?? null,
		}
		if (lives[id] !== undefined) changes[id] = { lives: lives[id] }
	}
	const run = withLives(
		{
			...base,
			players,
			pairings: pairing === null ? {} : { [pairing.ante]: pairing },
		},
		changes,
	)
	return {
		run,
		currentPvpBlind: pvpBlindOf(currentPvpBlind, `${pairing?.ante ?? 2}:Boss`),
	}
}

const pairOf = (ante: number, partners: { [id: string]: string | null }) => ({
	ante,
	partners,
	usedPairs: [],
	lastBye: null,
})

describe('onAnte', () => {
	const onAnte = nemesisMode.onAnte
	if (onAnte === undefined) throw new Error('nemesis has an onAnte')

	it('pairs the alive once the first ante is reported', () => {
		const { run } = game({ a: { ante: 1 }, b: { ante: 1 }, c: { ante: 1 } })
		const out = onAnte(run, scriptedRandom([0.2, 0.6]))
		expect(out.pairings[1]?.ante).toBe(1)
		expect(Object.keys(out.pairings[1]?.partners ?? {}).sort()).toEqual([
			'a',
			'b',
			'c',
		])
	})

	it('waits for an ante, and pairs a given ante only once', () => {
		const unreported = game({ a: {}, b: {}, c: {} }).run
		expect(onAnte(unreported, scriptedRandom())).toBe(unreported)
		const paired = game(
			{ a: { ante: 2 }, b: { ante: 2 }, c: { ante: 1 } },
			pairOf(2, { a: 'b', b: 'a', c: null }),
		).run
		expect(onAnte(paired, scriptedRandom())).toBe(paired)
	})

	it('reads the ante from the highest player, not the first', () => {
		const { run } = game({ a: { ante: 1 }, b: { ante: 4 }, c: { ante: 2 } })
		expect(Object.keys(onAnte(run, scriptedRandom([0.3])).pairings)).toEqual([
			'4',
		])
	})

	it('re-pairs when the ante rises, only among the alive', () => {
		const { run } = game(
			{ a: { ante: 3 }, b: { ante: 2 }, c: { ante: 2 }, d: { ante: 2 } },
			pairOf(2, { a: 'b', b: 'a', c: 'd', d: 'c' }),
			{ d: 0 },
		)
		const out = onAnte(run, scriptedRandom([0.5]))
		expect(out.pairings[3]?.ante).toBe(3)
		expect(Object.keys(out.pairings[3]?.partners ?? {}).sort()).toEqual([
			'a',
			'b',
			'c',
		])
		expect(out.pairings[2]).toBe(run.pairings[2])
	})
})

describe('losersOf', () => {
	const losersOf = (input: ReturnType<typeof game>) =>
		nemesisMode.losersOf(input.run, input.currentPvpBlind)
	const pairs = pairOf(1, { a: 'b', b: 'a', c: 'd', d: 'c' })

	it('each pair loses its lower score, a tie loses nobody', () => {
		expect(
			losersOf(
				game(
					{
						a: { score: '9', hands: 0 },
						b: { score: '3', hands: 0 },
						c: { score: '4', hands: 0 },
						d: { score: '4', hands: 0 },
					},
					pairs,
				),
			),
		).toEqual(['b'])
	})

	it('names the losers sorted, whichever side of the pair they are', () => {
		expect(
			losersOf(
				game(
					{
						a: { score: '1', hands: 0 },
						b: { score: '3', hands: 0 },
						c: { score: '5', hands: 0 },
						d: { score: '4', hands: 0 },
					},
					pairs,
				),
			),
		).toEqual(['a', 'd'])
	})

	it('the bye, and a player whose partner is dead, lose nothing', () => {
		expect(
			losersOf(
				game(
					{
						a: { score: '1', hands: 0 },
						b: { score: '9', hands: 0 },
						c: { score: '0', hands: 0 },
					},
					pairOf(1, { a: 'c', b: null, c: 'a' }),
					{ a: 0 },
				),
			),
		).toEqual([])
	})

	it('waits for every alive player, and with no pairing names no one', () => {
		expect(
			losersOf(
				game(
					{
						a: { score: '1', hands: 0 },
						b: { score: '3', hands: 1 },
						c: { score: '3', hands: 0 },
					},
					pairs,
				),
			),
		).toBeNull()
		expect(
			losersOf(
				game({
					a: { score: '1', hands: 0 },
					b: { score: '3', hands: 0 },
					c: { score: '3', hands: 0 },
				}),
			),
		).toEqual([])
	})

	it('waits for a player of another pair too', () => {
		expect(
			losersOf(
				game(
					{
						a: { score: '1', hands: 0 },
						b: { score: '3', hands: 0 },
						c: { score: '4', hands: 0 },
						d: { score: '4', hands: 2 },
					},
					pairs,
				),
			),
		).toBeNull()
	})

	it('a player who left loses nothing, and neither does their partner', () => {
		const state = game(
			{
				a: { score: '1', hands: 0 },
				b: { score: '3', hands: 0 },
				c: { score: '4', hands: 0 },
				d: { score: '2', hands: 0 },
			},
			pairs,
		)
		const left = {
			...state,
			run: withLives(state.run, { a: { status: 'left' } }),
		}
		expect(losersOf(left)).toEqual(['d'])
	})

	it('losers are one per pair at most, and never the bye', () => {
		const text = fc.nat({ max: 5 }).map(String)
		fc.assert(
			fc.property(fc.array(text, { minLength: 5, maxLength: 5 }), (scores) => {
				const [a, b, c, d, bye] = scores
				const losers =
					losersOf(
						game(
							{
								a: { score: a, hands: 0 },
								b: { score: b, hands: 0 },
								c: { score: c, hands: 0 },
								d: { score: d, hands: 0 },
								e: { score: bye, hands: 0 },
							},
							pairOf(1, { a: 'b', b: 'a', c: 'd', d: 'c', e: null }),
						),
					) ?? []
				expect(losers).not.toContain('e')
				expect(
					losers.filter((id) => id === 'a' || id === 'b').length,
				).toBeLessThanOrEqual(1)
				expect(
					losers.filter((id) => id === 'c' || id === 'd').length,
				).toBeLessThanOrEqual(1)
			}),
		)
	})

	it('does nothing with one alive', () => {
		expect(
			losersOf(
				game(
					{ a: { score: '1', hands: 0 }, b: { score: '3', hands: 0 } },
					null,
					{ b: 0 },
				),
			),
		).toBeNull()
	})
})

describe('view and the mode contract', () => {
	it('shows each alive player its partner and the pairing ante', () => {
		const { run } = game(
			{ a: {}, b: {}, c: {} },
			pairOf(2, { a: 'b', b: 'a', c: null }),
			{ c: 0 },
		)
		expect(nemesisMode.view(run, 2)).toEqual({
			opponents: { a: 'b', b: 'a' },
			pairingAnte: 2,
		})
	})

	it('a partner who died is still the survivor’s target', () => {
		const { run } = game(
			{ a: {}, b: {}, c: {} },
			pairOf(2, { a: 'b', b: 'a', c: null }),
			{ b: 0 },
		)
		expect(nemesisMode.view(run, 2)).toEqual({
			opponents: { a: 'b', c: null },
			pairingAnte: 2,
		})
	})

	it('shows nobody a partner before the first pairing', () => {
		const { run } = game({ a: {}, b: {} })
		expect(nemesisMode.view(run, 1)).toEqual({
			opponents: { a: null, b: null },
			pairingAnte: null,
		})
	})

	it('waits a death on everyone', () => {
		expect(nemesisMode.name).toBe('nemesis')
		expect(nemesisMode.deathWaitsOn).toBe('everyone')
		expect(nemesisMode.pairs).toBe('by ante')
	})
})
