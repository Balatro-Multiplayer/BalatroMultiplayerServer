import { describe, expect, it } from 'vitest'
import { closing, eventsFrom, play, pvpOpening, spdrnOpening, type Tuple } from '../../testing/replay_fixtures'
import { countOf, livesLost, suitChangersUsed } from './actions'
import { keyOfRef, learnRefs, type CardKeys } from './cards'
import { deckKeyOf } from './decks'
import { logFactsOf } from '.'
import { moneySpent } from './money'
import { bestHandScore, parseScore } from './score'
import { gameSetupOf } from './setup'
import { fastestRunMs } from './speedrun'

describe('card refs', () => {
	it('learns keys from first-seen refs anywhere in args, and resolves later refs', () => {
		const keys: CardKeys = {}
		learnRefs(keys, [3, [1], [-2, 'Spectral', 'c_incantation'], [[-5, 'pc', 'Hearts', 'Ace']]])
		learnRefs(keys, ['shop', [2, 1], [{ ref: [-7, 'Joker', 'j_blueprint', 'ed:foil'], old: 1, new: 2 }]])
		expect(keys).toEqual({ 2: 'c_incantation', 7: 'j_blueprint' })
		expect(keyOfRef(keys, [2])).toBe('c_incantation')
		expect(keyOfRef(keys, [7, 'ed:foil'])).toBe('j_blueprint')
		expect(keyOfRef(keys, [-9, 'Tarot', 'c_star'])).toBe('c_star')
		expect(keyOfRef(keys, [5])).toBeNull()
		expect(keyOfRef(keys, null)).toBeNull()
	})
})

describe('decks', () => {
	it('reads names, keys and tables; not challenge or modded decks', () => {
		expect(deckKeyOf('Red Deck')).toBe('b_red')
		expect(deckKeyOf('b_ghost')).toBe('b_ghost')
		expect(deckKeyOf({ key: 'b_anaglyph', stake: 2 })).toBe('b_anaglyph')
		expect(deckKeyOf({ id: 'c_luxury_1', key: 'b_challenge', challenge_id: 'c_luxury_1', challenge_name: 'Luxury Tax' })).toBeNull()
		expect(deckKeyOf('b_mp_heidelberg')).toBeNull()
		expect(deckKeyOf('Challenge Deck')).toBeNull()
		expect(deckKeyOf(null)).toBeNull()
	})
})

describe('game setup', () => {
	it('reads a PvP game: deck by name, Smallworld from the ruleset', () => {
		expect(gameSetupOf(eventsFrom(pvpOpening('Blue Deck')))).toEqual({ decks: ['b_blue'], smallworld: false, spdrnMode: null })
		expect(gameSetupOf(eventsFrom(pvpOpening('Red Deck', 'ruleset_mp_smallworld'))).smallworld).toBe(true)
	})

	it('reads every deck a Speedrun game ran, and prefers the server-stored gamemode', () => {
		const events = eventsFrom([
			...spdrnOpening('spdrn_all_deck', 'b_ghost'),
			[90000, 'run_complete', null],
			[90001, 'run_info', { deck: { key: 'b_plasma' }, seed: 'X', stake: 1 }],
			[180000, 'run_info', { deck: 'b_ghost', seed: 'Y', stake: 1 }],
		])
		expect(gameSetupOf(events)).toEqual({ decks: ['b_ghost', 'b_plasma'], smallworld: false, spdrnMode: 'spdrn_all_deck' })
		expect(gameSetupOf(events, 'spdrn_stake_climb').spdrnMode).toBe('spdrn_stake_climb')
		expect(gameSetupOf(events, 'not_a_mode').spdrnMode).toBe('spdrn_all_deck')
	})

	it('falls back to lobby_info decks when no run started, and counts no challenge deck', () => {
		const challenge = { id: 'c_luxury_1', key: 'b_challenge', challenge_id: 'c_luxury_1' }
		expect(gameSetupOf(eventsFrom(spdrnOpening('spdrn_challenge', challenge))).decks).toEqual([])
		expect(gameSetupOf(eventsFrom(pvpOpening('Green Deck').slice(0, 2))).decks).toEqual(['b_green'])
	})
})

describe('action counts', () => {
	it('counts hands, rerolls and skips', () => {
		const events = eventsFrom([...pvpOpening(), play(10, 1), [20, 'skip_blind', [0]], play(30, 3), [40, 'reroll', null], ...closing(50, 'win')])
		expect(countOf(events, 'play')).toBe(2)
		expect(countOf(events, 'skip_blind')).toBe(1)
		expect(countOf(events, 'reroll')).toBe(1)
	})

	it('counts suit changers used, whether first seen at use or earlier', () => {
		const events = eventsFrom([
			[1, 'buy', ['shop_jokers', 1, [-4, 'Tarot', 'c_star'], 3]],
			[2, 'use', [1, [1, 2], [4], [[-5, 'pc', 'Hearts', 'Ace'], [-6, 'pc', 'Clubs', '2']]]],
			[3, 'pack_pick', [2, [1], [-8, 'Spectral', 'c_sigil'], [[5]]]],
			[4, 'use', [1, [], [-9, 'Tarot', 'c_fool'], []]],
			[5, 'use', [1, [1], [-10, 'Tarot', 'c_world'], [[5]]]],
			[6, 'sell', ['consumeables', 1, [-11, 'Tarot', 'c_moon']]],
		])
		expect(suitChangersUsed(events)).toBe(3)
	})

	it('adds up PvP lives lost, one per event when the count is missing', () => {
		const events = eventsFrom([
			[1, 'life_lost', { lost: 1, lives: 3 }],
			[2, 'life_lost', { lost: 2, lives: 1 }],
			[3, 'life_lost', null],
		])
		expect(livesLost(events)).toBe(4)
	})
})

describe('money spent', () => {
	it('adds purchase costs and reroll costs', () => {
		const events = eventsFrom([
			[1, 'buy', ['shop_jokers', 1, [-1, 'Joker', 'j_egg'], 4]],
			[2, 'money_delta', [-4]],
			[3, 'open_pack', ['shop_booster', 1, [-2, 'Booster', 'p_arcana_normal_1'], 4]],
			[4, 'voucher', ['shop_vouchers', 1, [-3, 'Voucher', 'v_overstock_norm'], 10]],
			[5, 'reroll', { cost: 5 }],
			[6, 'money_delta', [-5]],
			[7, 'reroll', [6]],
			[8, 'money_delta', [7]],
		])
		expect(moneySpent(events)).toBe(29)
	})

	it('takes an old reroll\'s cost from the money_delta after it, and a free reroll as free', () => {
		const events = eventsFrom([
			[1, 'reroll', null],
			[2, 'money_delta', [-5]],
			[3, 'reroll', null],
			[4, 'reroll', null],
			[5, 'money_delta', [-6]],
			[6, 'reroll', null],
			[7, 'money_delta', [3]],
		])
		expect(moneySpent(events)).toBe(11)
	})
})

describe('scores', () => {
	it('parses score text, big numbers included', () => {
		expect(parseScore('180')).toBe(180)
		expect(parseScore('1,234')).toBe(1234)
		expect(parseScore('1.5e11')).toBe(1.5e11)
		expect(parseScore('1e400')).toBe(Infinity)
		expect(parseScore('e1.2e10')).toBe(Infinity)
		expect(parseScore('1.2ee10')).toBe(Infinity)
		expect(parseScore('10##5')).toBe(Infinity)
		expect(parseScore('naneinf')).toBe(Infinity)
		expect(parseScore('-5')).toBe(0)
		expect(parseScore('banana')).toBe(0)
		expect(parseScore(null)).toBe(0)
		expect(parseScore(250)).toBe(250)
	})

	it('parses score text', () => {
		expect(parseScore('12345')).toBe(12345)
		expect(parseScore('150000000000')).toBe(1.5e11)
		expect(parseScore('500.1760912590557,1')).toBe(Infinity)
		expect(parseScore('20.17609125905568,3')).toBe(Infinity)
		expect(parseScore('100,1')).toBeCloseTo(1e100, -90)
	})

	it('counts a hand score above 1e308 as a stunt score', () => {
		const events = eventsFrom([
			[1, 'hand_scored', { score: '300' }],
			[2, 'hand_scored', { score: '500.1760912590557,1' }],
		])
		expect(bestHandScore(events)).toBe(Infinity)
		expect(bestHandScore(eventsFrom([[1, 'hand_result', ['500.1760912590557,1', 0]]]))).toBe(Infinity)
	})

	it('takes the best hand from hand_scored', () => {
		const events = eventsFrom([
			[1, 'hand_scored', { score: '300' }],
			[2, 'hand_result', ['999999999999', 0]],
			[3, 'hand_scored', { score: '2e11' }],
			[4, 'hand_scored', ['50']],
		])
		expect(bestHandScore(events)).toBe(2e11)
	})

	it('falls back to the rise in PvP round totals in an old log', () => {
		// From a real PvP log: "0" posts between hands, a round of 180, a new round.
		const events = eventsFrom([
			[2692, 'hand_result', ['0', 4]],
			[29896, 'hand_result', ['100', 3]],
			[48015, 'hand_result', ['180', 0]],
			[62116, 'hand_result', ['0', 4]],
			[77848, 'hand_result', ['150', 3]],
		])
		expect(bestHandScore(events)).toBe(150)
		expect(bestHandScore(eventsFrom([]))).toBe(0)
	})
})

describe('Speedrun run time', () => {
	const hands = (from: number, count: number, gap: number): Tuple[] =>
		Array.from({ length: count }, (_, i) => play(from + (i + 1) * gap, i * 2 + 1))

	it('times each completed run from its run_info', () => {
		const events = eventsFrom([
			...spdrnOpening('spdrn_white_stake_triple'),
			...hands(2506, 10, 30000),
			[2506 + 400000, 'run_complete', null],
			[410000, 'run_info', { deck: 'b_red', seed: 'B', stake: 1 }],
			...hands(410000, 10, 40000),
			[410000 + 450000, 'run_complete', null],
		])
		expect(fastestRunMs(events, 900000, 3000)).toBe(400000)
	})

	it('ignores implausible runs: too few hands, faster than the hands allow, longer than the game', () => {
		const few = eventsFrom([...spdrnOpening(), ...hands(2506, 5, 1000), [9000, 'run_complete', null]])
		expect(fastestRunMs(few, 900000, 3000)).toBeNull()
		const quick = eventsFrom([...spdrnOpening(), ...hands(2506, 9, 100), [2506 + 20000, 'run_complete', null]])
		expect(fastestRunMs(quick, 900000, 3000)).toBeNull()
		const long = eventsFrom([...spdrnOpening(), ...hands(2506, 9, 30000), [2506 + 400000, 'run_complete', null]])
		expect(fastestRunMs(long, 300000, 3000)).toBeNull()
		const died = eventsFrom([...spdrnOpening(), ...hands(2506, 9, 30000), [300000, 'run_died', null]])
		expect(fastestRunMs(died, 900000, 3000)).toBeNull()
	})
})

describe('log facts', () => {
	it('collects everything from one real-shaped PvP log', () => {
		const events = eventsFrom([
			...pvpOpening('Yellow Deck'),
			[3000, 'select_blind', [0]],
			play(10000, 1),
			[11000, 'hand_scored', { score: '420' }],
			[11001, 'hand_result', ['420', 3]],
			[20000, 'skip_blind', [0]],
			[30000, 'buy', ['shop_jokers', 2, [-3, 'Tarot', 'c_sun'], 3]],
			[31000, 'reroll', { cost: 5 }],
			[32000, 'use', [1, [1], [3], [[1]]]],
			[33000, 'life_lost', { lost: 1, lives: 3 }],
			...closing(40000, 'loss'),
		])
		const facts = logFactsOf(events, { serverElapsedMs: 50000, serverGamemode: null, minMsPerHand: 3000 })
		expect(facts).toEqual({
			hands: 1,
			rerolls: 1,
			skips: 1,
			moneySpent: 8,
			suitChangers: 1,
			livesLost: 1,
			bestHandScore: 420,
			setup: { decks: ['b_yellow'], smallworld: false, spdrnMode: null },
			fastestSpdrnRunMs: null,
		})
	})
})
