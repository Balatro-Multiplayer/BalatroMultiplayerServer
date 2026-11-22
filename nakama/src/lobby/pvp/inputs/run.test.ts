import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { PvpBlindResult, State } from '../core/types'
import { runOf, send } from '../testing/inputs'
import { pairedRun, runInMode, runState } from '../testing/state'
import { livesOf } from '../testing/timers'
import { runPlayerView, shopHandler } from './run'

const DUEL = ['ann', 'bob']

function progress(state: State, player: string, ante: number): State {
	return send(state, player, { kind: 'progress', ante, location: 'shop' }).state
}

function atAnte(players: string[], ante: number, state?: State): State {
	return players.reduce(
		(next, player) => progress(next, player, ante),
		state ?? runState(players),
	)
}

describe('progress', () => {
	it('keeps the highest ante and always the latest location', () => {
		let state = send(runState(DUEL), 'ann', {
			kind: 'progress',
			ante: 3,
			location: 'shop',
		}).state
		state = send(state, 'ann', {
			kind: 'progress',
			ante: 2,
			location: 'blind_select',
		}).state
		expect(runOf(state).players.ann).toMatchObject({
			ante: 3,
			location: 'blind_select',
		})
	})

	it.each([
		['a negative ante', { ante: -1, location: 'shop' }],
		['a fractional ante', { ante: 1.5, location: 'shop' }],
		['no location', { ante: 1 }],
		['an unknown field', { ante: 1, location: 'shop', extra: true }],
	])('%s is confirmed and refused', (_name, fields) => {
		const state = runState(DUEL)
		const result = send(state, 'ann', { kind: 'progress', ...fields })
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(result.state.run).toEqual(state.run)
		expect(result.lastNumber).toBe(1)
	})
})

describe('pairing follows the highest ante', () => {
	const four = ['ann', 'bob', 'cy', 'di']

	it('pairs once per ante, the same way for the same run', () => {
		const first = atAnte(four, 1)
		const pairing = runOf(first).pairings[1]
		expect(pairing?.ante).toBe(1)
		expect(atAnte(four, 1).run?.pairings[1]).toEqual(pairing)
		const again = progress(first, 'ann', 1)
		expect(runOf(again).pairings[1]).toBe(pairing)
		expect(runOf(progress(first, 'ann', 2)).pairings[2]?.ante).toBe(2)
	})

	it('the draw depends on the run: different runs pair the same four players differently', () => {
		const partnersOf = (id: string): string => {
			const base = runInMode(four, 'nemesis')
			const seeded: State = { ...base, run: { ...runOf(base), id } }
			return JSON.stringify(atAnte(four, 1, seeded).run?.pairings[1]?.partners)
		}
		const drawn = new Set(
			Array.from({ length: 12 }, (_, index) => partnersOf(`run-${index}`)),
		)
		expect(drawn.size).toBeGreaterThan(1)
	})
})

describe('blindResult', () => {
	it('takes one life for a lost normal blind, once however often it is sent', () => {
		let state = atAnte(DUEL, 2)
		const lost = {
			kind: 'blindResult',
			blindKey: '2:Small',
			result: 'lost',
		}
		state = send(state, 'ann', lost).state
		expect(livesOf(state, 'ann')).toBe(3)
		state = send(state, 'ann', lost).state
		state = send(state, 'ann', { ...lost, result: 'failed on the clock' }).state
		expect(livesOf(state, 'ann')).toBe(3)
		expect(runOf(state).players.ann.results['2:Small']).toEqual({
			result: 'lost',
		})
	})

	it('a lost blind that is not lost for the PvP blind costs nothing', () => {
		const state = send(atAnte(DUEL, 2), 'ann', {
			kind: 'blindResult',
			blindKey: '2:Small',
			result: 'failed on the clock',
		}).state
		expect(livesOf(state, 'ann')).toBe(4)
	})

	it.each([
		['skipped', { result: 'skipped' }],
		['an unknown result', { result: 'won' }],
		['the old flags', { beaten: false, roundLost: true }],
	])('refuses %s from a client', (_name, fields) => {
		const result = send(atAnte(DUEL, 2), 'ann', {
			kind: 'blindResult',
			blindKey: '2:Small',
			...fields,
		})
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(runOf(result.state).players.ann.results['2:Small']).toBeUndefined()
	})

	const bossLost = {
		kind: 'blindResult',
		blindKey: '2:Boss',
		result: 'lost',
	}

	it('pvp_blind_loses_one_life: refused for a blind with an open PvP blind of this player', () => {
		const opened = send(atAnte(DUEL, 2), 'ann', {
			kind: 'ready',
			ready: true,
			blindKey: '2:Boss',
		}).state
		const result = send(opened, 'ann', bossLost)
		expect(result.refusals).toEqual(['pvp_blind'])
		expect(livesOf(result.state, 'ann')).toBe(4)
		expect(result.lastNumber).toBe(1)
	})

	it('pvp_blind_loses_one_life: refused for a blind with a finished PvP blind of this player', () => {
		const state = atAnte(DUEL, 2)
		const done: PvpBlindResult = {
			blindKey: '2:Boss',
			scores: { ann: '1', bob: '2' },
			endedBy: { ann: 'hands', bob: 'hands' },
			losers: ['ann'],
			livesAfter: { ann: 3, bob: 4 },
			teamScores: null,
		}
		const finished: State = {
			...state,
			run: { ...runOf(state), finishedPvpBlinds: [done] },
		}
		const result = send(finished, 'ann', bossLost)
		expect(result.refusals).toEqual(['pvp_blind'])
		expect(result.state.run).toEqual(finished.run)
	})

	it("a finished PvP blind of other players does not own this player's blind", () => {
		const state = atAnte(['ann', 'bob', 'cy'], 2)
		const done: PvpBlindResult = {
			blindKey: '2:Boss',
			scores: { bob: '1', cy: '2' },
			endedBy: { bob: 'hands', cy: 'hands' },
			losers: ['bob'],
			livesAfter: { ann: 4, bob: 3, cy: 4 },
			teamScores: null,
		}
		const finished: State = {
			...state,
			run: { ...runOf(state), finishedPvpBlinds: [done] },
		}
		const result = send(finished, 'ann', bossLost)
		expect(result.refusals).toEqual([])
		expect(livesOf(result.state, 'ann')).toBe(3)
	})

	it('a repeat of a first result is accepted quietly', () => {
		const lost = { ...bossLost, blindKey: '2:Small' }
		const once = send(atAnte(DUEL, 2), 'ann', lost).state
		const again = send(once, 'ann', lost)
		expect(again.refusals).toEqual([])
		expect(again.state.run).toEqual(once.run)
	})

	it('pvp_blind_is_refused: a player with a bye plays the PvP blind, so it is no blind result either', () => {
		const withBye = pairedRun(['ann', 'bob', 'cy'], {
			ann: null,
			bob: 'cy',
			cy: 'bob',
		})
		const refused = send(withBye, 'ann', bossLost)
		expect(refused.refusals).toEqual(['pvp_blind'])
		expect(livesOf(refused.state, 'ann')).toBe(4)
	})

	it.each([
		['no progress reported', runState(DUEL), '2:Small', 'no_progress'],
		['a blind past the ante', atAnte(DUEL, 2), '3:Small', 'ahead_of_progress'],
	])('is refused for %s', (_name, state, blindKey, code) => {
		const result = send(state, 'ann', {
			kind: 'blindResult',
			blindKey,
			result: 'lost',
		})
		expect(result.refusals).toEqual([code])
		expect(result.state.run).toEqual(state.run)
	})
})

describe('skip', () => {
	const skip = (blindKey: string, total: number) => ({
		kind: 'skip',
		blindKey,
		total,
	})

	it('takes the run total and never a lower one', () => {
		let state = atAnte(DUEL, 2)
		state = send(state, 'ann', skip('2:Small', 3)).state
		state = send(state, 'ann', skip('2:Big', 2)).state
		expect(runOf(state).skips.ann.skips).toBe(3)
	})

	it('a player with no progress reported skips at the first ante', () => {
		const first = send(runState(DUEL), 'ann', skip('1:Small', 2))
		expect(first.refusals).toEqual([])
		expect(runOf(first.state).skips.ann.skips).toBe(2)
		const later = send(runState(DUEL), 'ann', skip('2:Small', 1))
		expect(later.refusals).toEqual(['no_progress'])
	})

	it('a skipped blind is recorded as skipped, and never replaces an answer already there', () => {
		const skipped = send(atAnte(DUEL, 2), 'ann', skip('2:Small', 1)).state
		expect(runOf(skipped).players.ann.results['2:Small']).toEqual({
			result: 'skipped',
		})
		expect(livesOf(skipped, 'ann')).toBe(4)
		const answered = send(atAnte(DUEL, 2), 'ann', {
			kind: 'blindResult',
			blindKey: '2:Big',
			result: 'lost',
		}).state
		const after = send(answered, 'ann', skip('2:Big', 1)).state
		expect(runOf(after).players.ann.results['2:Big']).toEqual({
			result: 'lost',
		})
		expect(runOf(after).skips.ann.skips).toBe(1)
	})

	it('a repeated total is accepted quietly and changes nothing', () => {
		const once = send(atAnte(DUEL, 2), 'ann', skip('2:Small', 2)).state
		const again = send(once, 'ann', skip('2:Big', 2))
		expect(again.refusals).toEqual([])
		expect(again.state.run).toEqual(once.run)
	})

	it('refuses a blind past the ante', () => {
		const result = send(atAnte(DUEL, 2), 'ann', skip('3:Small', 1))
		expect(result.refusals).toEqual(['ahead_of_progress'])
	})
})

describe('shop spends (the game pays Penny Pincher itself)', () => {
	const shop = (total: number, spent: number | null, ante = 2) => ({
		kind: 'shop',
		ante,
		total,
		spent,
	})

	it('keeps the dollars of each shop, once per shop, and tells nobody', () => {
		let state = atAnte(DUEL, 2)
		state = send(state, 'ann', shop(1, 10)).state
		state = send(state, 'ann', shop(1, 30)).state
		state = send(state, 'ann', shop(2, 4)).state
		expect(runOf(state).players.ann.shopSpends).toEqual({ '1': 10, '2': 4 })
		expect(runOf(state).players.bob.inbox).toEqual([])
		expect(runPlayerView(runOf(state), 'ann').shopSpends).toEqual([10, 4])
	})

	it('a shop that is sent again with its own total changes nothing', () => {
		const once = send(atAnte(DUEL, 2), 'ann', shop(1, 10)).state
		const again = send(once, 'ann', shop(1, 10))
		expect(again.refusals).toEqual([])
		expect(again.state.run).toEqual(once.run)
	})

	it('a shop total counts once per run, not once per ante', () => {
		const once = send(atAnte(DUEL, 2), 'ann', shop(1, 10)).state
		const later = atAnte(DUEL, 3, once)
		const again = send(later, 'ann', shop(1, 10, 3))
		expect(again.refusals).toEqual([])
		expect(again.state.run).toEqual(later.run)
	})

	it('a skipped shop is 0 dollars', () => {
		const state = send(atAnte(DUEL, 2), 'ann', shop(1, null)).state
		expect(runOf(state).players.ann.shopSpends).toEqual({ '1': 0 })
	})

	it('a shop for an ante past the reported one is refused', () => {
		const result = send(atAnte(DUEL, 2), 'ann', shop(1, 3, 3))
		expect(result.refusals).toEqual(['ahead_of_progress'])
	})

	it('refuses a spend nobody can make', () => {
		const result = send(atAnte(DUEL, 2), 'ann', shop(1, 1_000_001))
		expect(result.refusals).toEqual(['bad_request_body'])
	})
})

describe('voucher', () => {
	const roster = { ann: 'RUNNER', bob: 'HUNTER', cy: 'HUNTER' } as const
	const hunt = () => runInMode(['ann', 'bob', 'cy'], 'manhunt', roster)
	const redeem = (voucherKey: string) => ({ kind: 'voucher', voucherKey })

	it("gives every Hunter a life and an item for a Runner's voucher, once per key", () => {
		let state = send(hunt(), 'ann', redeem('v_hieroglyph')).state
		expect([livesOf(state, 'bob'), livesOf(state, 'cy')]).toEqual([5, 5])
		expect(runOf(state).players.bob.inbox).toEqual([
			{ itemNumber: 1, from: 'ann', effect: 'voucherLife', amount: 1 },
		])
		const again = send(state, 'ann', redeem('v_hieroglyph'))
		expect(again.refusals).toEqual(['already_redeemed'])
		expect(again.state.run).toEqual(state.run)
		state = send(state, 'ann', redeem('v_petroglyph')).state
		expect(livesOf(state, 'bob')).toBe(6)
	})

	it('the Runner gets no item of its own for its voucher', () => {
		const state = send(hunt(), 'ann', redeem('v_hieroglyph')).state
		expect(runOf(state).players.ann.inbox).toEqual([])
		expect(livesOf(state, 'ann')).toBe(4)
	})

	it('a repeat of a redeemed key is quietly dropped by its own refusal only', () => {
		const state = send(hunt(), 'ann', redeem('v_hieroglyph')).state
		const again = send(state, 'ann', redeem('v_hieroglyph'))
		expect(again.refusals).toEqual(['already_redeemed'])
	})

	it('is refused for a Hunter and in a mode with no voucher', () => {
		const hunter = send(hunt(), 'bob', redeem('v_hieroglyph'))
		expect(hunter.refusals).toEqual(['not_in_run'])
		const duel = send(runState(DUEL), 'ann', redeem('v_hieroglyph'))
		expect(duel.refusals).toEqual(['not_in_run'])
		expect(duel.state.run).toEqual(runState(DUEL).run)
	})
})

describe('sells are counted per ante', () => {
	const sell = (ante: number, total: number) => ({ kind: 'sell', ante, total })

	it('sells_are_per_ante: a redo of ante 2 sent in ante 3 changes neither count', () => {
		let state = atAnte(DUEL, 2)
		state = send(state, 'ann', sell(2, 3)).state
		state = atAnte(DUEL, 3, state)
		state = send(state, 'ann', sell(3, 1)).state
		const before = runOf(state).players.ann.sells
		const redo = send(state, 'ann', sell(2, 3))
		expect(runOf(redo.state).players.ann.sells).toEqual(before)
		expect(before).toEqual({ '2': 3, '3': 1 })
	})

	it('refuses a sell for an ante past the reported one', () => {
		const result = send(atAnte(DUEL, 2), 'ann', sell(3, 1))
		expect(result.refusals).toEqual(['ahead_of_progress'])
	})
})

describe('run totals', () => {
	const sellStep = fc.record({
		ante: fc.integer({ min: 1, max: 3 }),
		total: fc.integer({ min: 1, max: 6 }),
	})
	const shopStep = fc.record({
		ante: fc.integer({ min: 1, max: 3 }),
		total: fc.integer({ min: 1, max: 8 }),
		spent: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
	})
	type Step =
		| { kind: 'sell'; ante: number; total: number }
		| { kind: 'shop'; ante: number; total: number; spent: number | null }
		| { kind: 'skip'; blindKey: string; total: number }
	const step: fc.Arbitrary<Step> = fc.oneof(
		sellStep.map((fields): Step => ({ kind: 'sell', ...fields })),
		shopStep.map((fields): Step => ({ kind: 'shop', ...fields })),
		fc
			.record({
				ante: fc.integer({ min: 1, max: 3 }),
				total: fc.integer({ min: 1, max: 6 }),
			})
			.map(
				({ ante, total }): Step => ({
					kind: 'skip',
					blindKey: `${ante}:Small`,
					total,
				}),
			),
	)
	const steps = fc.array(step, { maxLength: 30 })

	function sendAll(state: State, list: Step[]): State {
		return list.reduce((next, body) => send(next, 'ann', body).state, state)
	}

	it('totals_count_each_action_once: any mix of first sends and redos counts each action once', () => {
		fc.assert(
			fc.property(steps, (list) => {
				const state = sendAll(atAnte(DUEL, 3), list)
				const sells: { [ante: string]: number } = {}
				let skips = 0
				let shopsClosed = 0
				const spends: { [shopNumber: string]: number } = {}
				for (const body of list) {
					const total = Number(body.total)
					if (body.kind === 'sell') {
						const key = String(body.ante)
						sells[key] = Math.max(sells[key] ?? 0, total)
					} else if (body.kind === 'skip') {
						skips = Math.max(skips, total)
					} else if (total > shopsClosed) {
						shopsClosed = total
						spends[String(total)] = body.spent ?? 0
					}
				}
				const run = runOf(state)
				expect(run.players.ann.sells).toEqual(sells)
				expect(run.skips.ann?.skips ?? 0).toBe(skips)
				expect(run.players.ann.shopSpends).toEqual(spends)
				expect(run.players.bob.inbox).toEqual([])
			}),
		)
	})

	it('replay_from_older_save_changes_nothing: sending the later inputs again with their totals changes nothing', () => {
		fc.assert(
			fc.property(steps, fc.nat(30), (list, cut) => {
				const done = sendAll(atAnte(DUEL, 3), list)
				const replayed = sendAll(done, list.slice(Math.min(cut, list.length)))
				expect(replayed.run).toEqual(done.run)
			}),
		)
	})
})

describe('shop spends in the view of a player', () => {
	const withSpends = (spends: { [shop: string]: number }): State => {
		const state = runState(DUEL)
		const run = runOf(state)
		return {
			...state,
			run: {
				...run,
				players: {
					...run.players,
					ann: { ...run.players.ann, shopSpends: spends },
				},
			},
		}
	}
	const shown = (spends: { [shop: string]: number }) =>
		runPlayerView(runOf(withSpends(spends)), 'ann').shopSpends

	it('lists shop 1 first, with null for a shop that has no total', () => {
		expect(shown({ '1': 3, '3': 7 })).toEqual([3, null, 7])
		expect(shown({ '2': 0 })).toEqual([null, 0])
		expect(shown({})).toEqual([])
	})

	it('keeps shops in number order past nine shops', () => {
		const spends: { [shop: string]: number } = {}
		for (let shop = 1; shop <= 12; shop++) spends[String(shop)] = shop * 10
		expect(shown(spends)).toEqual([
			10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
		])
		expect(shown({ '10': 1, '9': 2, '2': 3 })).toEqual([
			null,
			3,
			null,
			null,
			null,
			null,
			null,
			null,
			2,
			1,
		])
	})

	it('the first total for a shop stands, even when a later one reaches the part', () => {
		const state = withSpends({ '1': 10 })
		const again = shopHandler.handle(
			state,
			'ann',
			{ ante: 1, total: 1, spent: 30 },
			0,
			null,
		)
		expect(again).toEqual(state)
		const next = shopHandler.handle(
			state,
			'ann',
			{ ante: 1, total: 2, spent: 30 },
			0,
			null,
		)
		expect(runOf(next as State).players.ann.shopSpends).toEqual({
			'1': 10,
			'2': 30,
		})
	})
})

describe('runPlayerView', () => {
	it('copies what the player reported, with the lives the ledger holds', () => {
		const state = send(atAnte(DUEL, 2), 'ann', {
			kind: 'sell',
			ante: 2,
			total: 2,
		}).state
		const view = runPlayerView(runOf(state), 'ann')
		expect(view).toEqual({
			lives: 4,
			ante: 2,
			location: 'shop',
			skips: 0,
			sells: { '2': 2 },
			shopSpends: [],
		})
		expect(view.sells).not.toBe(runOf(state).players.ann.sells)
	})

	it('shows the skips the run holds, 0 for a player who has not skipped', () => {
		const state = send(atAnte(DUEL, 2), 'ann', {
			kind: 'skip',
			blindKey: '2:Small',
			total: 2,
		}).state
		expect(runPlayerView(runOf(state), 'ann').skips).toBe(2)
		expect(runPlayerView(runOf(state), 'bob').skips).toBe(0)
	})
})

describe('a player out of the run', () => {
	const out = (state: State, flag: 'eliminated' | 'forfeited'): State => {
		const run = runOf(state)
		return {
			...state,
			run: {
				...run,
				lives: {
					...run.lives,
					ann: {
						...run.lives.ann,
						status: flag === 'eliminated' ? 'out' : 'forfeited',
					},
				},
			},
		}
	}

	it.each([
		['eliminated', 'shop', { ante: 2, total: 1, spent: 3 }],
		['forfeited', 'shop', { ante: 2, total: 1, spent: 3 }],
		['eliminated', 'skip', { blindKey: '2:Small', total: 1 }],
		['forfeited', 'skip', { blindKey: '2:Small', total: 1 }],
	] as const)('%s: %s is refused', (flag, kind, fields) => {
		const state = out(atAnte(DUEL, 2), flag)
		const result = send(state, 'ann', { kind, ...fields })
		expect(result.refusals).toEqual(['eliminated'])
		expect(result.state.run).toEqual(state.run)
	})
})

describe('lives change only through the ledger', () => {
	const lives = (state: State) =>
		Object.fromEntries(
			Object.entries(runOf(state).lives).map(([id, seat]) => [id, seat.lives]),
		)
	const step = fc.oneof(
		fc.record({
			kind: fc.constant('sell'),
			ante: fc.integer({ min: 1, max: 2 }),
			total: fc.integer({ min: 1, max: 5 }),
		}),
		fc.record({
			kind: fc.constant('shop'),
			ante: fc.integer({ min: 1, max: 2 }),
			total: fc.integer({ min: 1, max: 5 }),
			spent: fc.integer({ min: 0, max: 20 }),
		}),
		fc.record({
			kind: fc.constant('skip'),
			blindKey: fc.constantFrom('1:Small', '2:Big'),
			total: fc.integer({ min: 1, max: 2 }),
		}),
		fc.record({
			kind: fc.constant('progress'),
			ante: fc.integer({ min: 1, max: 3 }),
			location: fc.constant('shop'),
		}),
	)

	it('lives_change_only_through_rules: other inputs never change a life', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.constantFrom('ann', 'bob'), step), {
					maxLength: 25,
				}),
				(list) => {
					let state = atAnte(DUEL, 2)
					for (const [player, body] of list) {
						const before = lives(state)
						const after = send(state, player, body).state
						expect(lives(after)).toEqual(before)
						state = after
					}
				},
			),
		)
	})

	it('a lost blind and a voucher are the ways a life moves, and each goes through once', () => {
		const lost = {
			kind: 'blindResult',
			blindKey: '2:Small',
			result: 'lost',
		}
		const once = send(atAnte(DUEL, 2), 'ann', lost)
		expect(lives(once.state)).toEqual({ ann: 3, bob: 4 })
		const again = send(once.state, 'ann', lost)
		expect(again.refusals).toEqual([])
		expect(lives(again.state)).toEqual({ ann: 3, bob: 4 })
	})
})

describe('teams are charged once per ante', () => {
	it('a lost blind costs the team a life each ante, not each blind', () => {
		const four = ['ann', 'bob', 'cat', 'dan']
		const base = runInMode(four, 'teams', {
			ann: 'A',
			bob: 'A',
			cat: 'B',
			dan: 'B',
		})
		const lost = (blindKey: string) => ({
			kind: 'blindResult',
			blindKey,
			result: 'lost',
		})
		let state: State = {
			...base,
			run: { ...runOf(base), teamLives: { A: 4, B: 4 } },
		}
		state = atAnte(four, 2, state)
		state = send(state, 'ann', lost('2:Small')).state
		state = send(state, 'bob', lost('2:Small')).state
		expect(runOf(state).teamLives).toEqual({ A: 3, B: 4 })
		state = send(state, 'ann', lost('2:Big')).state
		expect(runOf(state).teamLives).toEqual({ A: 3, B: 4 })
		state = progress(state, 'ann', 2)
		state = send(state, 'ann', lost('2:Boss')).state
		expect(runOf(state).teamLives).toEqual({ A: 3, B: 4 })
		state = atAnte(four, 3, state)
		state = send(state, 'ann', lost('3:Small')).state
		expect(runOf(state).teamLives).toEqual({ A: 2, B: 4 })
	})
})
