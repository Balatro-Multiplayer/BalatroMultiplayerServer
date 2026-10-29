// Shared vector table for score text. MPAPI (lib/big_score.lua) must give the
// same answers: the table is copied by hand into the ClaudeControl suite
// suites/mpapi/big_score.lua, which runs in a real game with no mods, with
// Talisman and with Amulet. Expected values come from the OmegaNum rules and
// from Python's math.log10, not from this module.

import { describe, expect, it } from 'vitest'
import {
	MAX_ARRAY_LENGTH,
	TOP_SCORE,
	ZERO_SCORE,
	compareScores,
	displayScore,
	fromArray,
	fromNumber,
	normalizeScore,
	scoreSortKey,
	parseLegacyScore,
	scoreToNumber,
} from './big-score'

const LARGEST_DOUBLE_TEXT = '308.25471555991675,1'
const TOP = Array(100).fill('9007199254740991').join(',')

// Game values and the score text each one must give.
type ValueVector =
	| { kind: 'double'; value: number | 'inf' | '-inf' | 'nan'; text: string }
	| {
			kind: 'omega'
			array: (number | 'inf' | 'nan')[]
			sign: 1 | -1
			text: string
	  }
	| { kind: 'bignum'; m: number; e: number; text: string }
	// Text a client may send in place of score text; the vanilla rule makes nan and inf the largest double.
	| { kind: 'text'; value: string; text: string }

export const VALUE_VECTORS: ValueVector[] = [
	{ kind: 'double', value: 0, text: '0' },
	{ kind: 'double', value: 12345, text: '12345' },
	{ kind: 'double', value: 123456789012345, text: '123456789012345' },
	{ kind: 'double', value: 2.9, text: '2' },
	{ kind: 'double', value: 0.5, text: '0' },
	{ kind: 'double', value: -5, text: '0' },
	{ kind: 'double', value: 9007199254740991, text: '9007199254740991' },
	{ kind: 'double', value: 1e15, text: '1000000000000000' },
	{ kind: 'double', value: 1e16, text: '16,1' },
	{ kind: 'double', value: 1e100, text: '100,1' },
	{ kind: 'double', value: 1.5e20, text: '20.17609125905568,1' },
	{ kind: 'double', value: 'inf', text: LARGEST_DOUBLE_TEXT },
	{ kind: 'double', value: 'nan', text: LARGEST_DOUBLE_TEXT },
	{ kind: 'double', value: '-inf', text: '0' },
	{
		kind: 'omega',
		array: [20.17609125905568, 1],
		sign: 1,
		text: '20.17609125905568,1',
	},
	// Talisman keeps small values in log form: {7,1} is 10^7.
	{ kind: 'omega', array: [7, 1], sign: 1, text: '10000000' },
	{ kind: 'omega', array: [10, 2], sign: 1, text: '10000000000,1' },
	{ kind: 'omega', array: [20, 2], sign: 1, text: '20,2' },
	{ kind: 'omega', array: [1.5e20, 2], sign: 1, text: '20.17609125905568,3' },
	{ kind: 'omega', array: [1, 0, 1], sign: 1, text: '10' },
	{ kind: 'omega', array: [20, 1, 0, 0], sign: 1, text: '20,1' },
	{ kind: 'omega', array: [123.7], sign: 1, text: '123' },
	{ kind: 'omega', array: [123], sign: -1, text: '0' },
	{ kind: 'omega', array: [0], sign: 1, text: '0' },
	{ kind: 'omega', array: ['inf'], sign: 1, text: TOP },
	{ kind: 'omega', array: ['nan'], sign: 1, text: TOP },
	{ kind: 'omega', array: ['inf'], sign: -1, text: '0' },
	{ kind: 'bignum', m: 1, e: 100, text: '100,1' },
	{ kind: 'bignum', m: 5, e: 3, text: '5000' },
	{ kind: 'bignum', m: -1, e: 100, text: '0' },
	{ kind: 'text', value: 'nan', text: LARGEST_DOUBLE_TEXT },
	{ kind: 'text', value: 'inf', text: LARGEST_DOUBLE_TEXT },
	{ kind: 'text', value: 'infinity', text: LARGEST_DOUBLE_TEXT },
	{ kind: 'text', value: 'naneinf', text: LARGEST_DOUBLE_TEXT },
]

// Score text and the canonical text it normalizes to. A null result is
// malformed text.
export const PARSE_VECTORS: [string, string | null][] = [
	['0', '0'],
	['5', '5'],
	['5,0', '5'],
	['1.5', '1'],
	['7,1', '10000000'],
	['20,1,0', '20,1'],
	['20.17609125905568,1', '20.17609125905568,1'],
	['100000000000000000000', '20,1'],
	[TOP, TOP],
	['', null],
	[' 1', null],
	['1 ', null],
	['1,', null],
	[',1', null],
	['1,,2', null],
	['a', null],
	['-1', null],
	['+1', null],
	['1e5', null],
	['1.', null],
	['.5', null],
	['1.5.2', null],
	['1,2.5', null],
	['01', null],
	['NaN', null],
	['Infinity', null],
	['1;2', null],
	[Array(101).fill('1').join(','), null],
]

// [a, b, sign of compare(a, b)]
export const ORDER_VECTORS: [string, string, -1 | 0 | 1][] = [
	['0', '1', -1],
	['1', '0', 1],
	['0', '0', 0],
	['9007199254740991', '16,1', -1],
	['20000000000000', '150000000000', 1],
	['16,1', '16.5,1', -1],
	['20,2', '20,1', 1],
	['100,1', '1000,1', -1],
	['5,1,1', '1000000,1', 1],
	['10000000', '7,1', 0],
	['20,1', '20,1', 0],
	['20,1,0', '20,1', 0],
	['20,5,1', '9007199254740991,9007199254740991', 1],
	['20,5,1', '20,5,2', -1],
	['20,5,1', '30,5,1', -1],
	[TOP, '9007199254740991,9007199254740991', 1],
]

// [score text, Balatro notation]
export const DISPLAY_VECTORS: [string, string][] = [
	['0', '0'],
	['7', '7'],
	['12345', '12,345'],
	['99999999999', '99,999,999,999'],
	['100000000000', '1e11'],
	['150000000000', '1.5e11'],
	['999960000000', '1e12'],
	['9007199254740991', '9.007e15'],
	['20.17609125905568,1', '1.5e20'],
	['100,1', '1e100'],
	['1234.5,1', '3.162e1,234'],
	['20,2', 'e1e20'],
	['20,3', 'ee1e20'],
	['2000000,1', 'e2e6'],
	['20,5,1', 'e20#5#2'],
	[TOP, 'e9.007e15#9.007e15##98'],
]

describe('score text from game values', () => {
	for (const v of VALUE_VECTORS) {
		const label =
			v.kind === 'double'
				? `double ${v.value}`
				: v.kind === 'omega'
					? `omega [${v.array}] sign ${v.sign}`
					: v.kind === 'text'
						? `text ${v.value}`
						: `bignum ${v.m}e${v.e}`
		it(`${label} -> ${v.text.slice(0, 40)}`, () => {
			if (v.kind === 'double') {
				const n =
					v.value === 'inf'
						? Number.POSITIVE_INFINITY
						: v.value === '-inf'
							? Number.NEGATIVE_INFINITY
							: v.value === 'nan'
								? Number.NaN
								: v.value
				expect(fromNumber(n)).toBe(v.text)
			} else if (v.kind === 'omega') {
				const array = v.array.map((x) =>
					x === 'inf' ? Number.POSITIVE_INFINITY : x === 'nan' ? Number.NaN : x,
				)
				expect(fromArray(array, v.sign)).toBe(v.text)
			} else if (v.kind === 'text') {
				expect(parseLegacyScore(v.value)).toBe(v.text)
			}
			// A bignum (Talisman's old mantissa and exponent number) is read
			// from the game by the Lua side only, so the table row checks that
			// side and nothing here.
		})
	}
})

describe('parse and normalize', () => {
	for (const [text, want] of PARSE_VECTORS) {
		it(`${JSON.stringify(text.slice(0, 30))} -> ${want === null ? 'rejected' : want.slice(0, 30)}`, () => {
			expect(normalizeScore(text)).toBe(want)
		})
	}

	it('keeps the limits in step with the Lua side', () => {
		expect(MAX_ARRAY_LENGTH).toBe(100)
		expect(TOP_SCORE).toBe(TOP)
		expect(ZERO_SCORE).toBe('0')
	})

	it('writes the same text for text it wrote itself', () => {
		for (const v of VALUE_VECTORS) {
			if (v.text === TOP) continue
			expect(normalizeScore(v.text)).toBe(v.text)
		}
	})
})

describe('compare', () => {
	for (const [a, b, want] of ORDER_VECTORS) {
		it(`${a.slice(0, 20)} vs ${b.slice(0, 20)} is ${want}`, () => {
			expect(compareScores(a, b)).toBe(want)
			expect(compareScores(b, a)).toBe(-want || 0)
		})
	}

	it('is null for malformed text', () => {
		expect(compareScores('x', '1')).toBeNull()
		expect(compareScores('1', '')).toBeNull()
	})
})

describe('display', () => {
	for (const [text, want] of DISPLAY_VECTORS) {
		it(`${text.slice(0, 24)} -> ${want}`, () => {
			expect(displayScore(text)).toBe(want)
		})
	}

	it('is null for malformed text', () => {
		expect(displayScore('x')).toBeNull()
	})
})

describe('sort key', () => {
	it('is the array length and the array from the top entry down', () => {
		expect(scoreSortKey('5')).toEqual({ len: 1, rev: [5] })
		expect(scoreSortKey('20.5,2')).toEqual({ len: 2, rev: [2, 20.5] })
		expect(scoreSortKey('20,2,3')).toEqual({ len: 3, rev: [3, 2, 20] })
	})

	it('is the canonical form, not the text as sent', () => {
		expect(scoreSortKey('0005')).toBeNull()
		expect(scoreSortKey('9007199254740992')).toEqual({
			len: 2,
			rev: [1, 15.954589770191003],
		})
	})

	it('is null for malformed text', () => {
		expect(scoreSortKey('x')).toBeNull()
		expect(scoreSortKey('')).toBeNull()
	})

	it('orders like compareScores (length first, then from the top entry)', () => {
		const texts = [
			'0',
			'5',
			'1000000000000000',
			'308.25471555991675,1',
			'20,2',
			'3,2',
			'20,1,1',
			TOP,
		]
		const rowCompare = (a: string, b: string) => {
			const x = scoreSortKey(a)
			const y = scoreSortKey(b)
			if (x === null || y === null) return null
			if (x.len !== y.len) return x.len > y.len ? 1 : -1
			for (let i = 0; i < x.rev.length; i++) {
				if (x.rev[i] !== y.rev[i]) return x.rev[i] > y.rev[i] ? 1 : -1
			}
			return 0
		}
		for (const a of texts)
			for (const b of texts) expect(rowCompare(a, b)).toBe(compareScores(a, b))
	})
})

// Text from logs written before score text existed. Expected values: Python
// math.log10 for the exponent forms, plain digits for the integer forms.
const LEGACY_VECTORS: [string, string][] = [
	['300', '300'],
	['2,832', '2832'],
	['1,234,567', '1234567'],
	['20000000000000', '20000000000000'],
	['1.2345678901234e+14', '123456789012340'],
	['1.5e11', '150000000000'],
	['1.5e+20', '20.17609125905568,1'],
	['1.5e500', '500.1760912590557,1'],
	['1.5e5,00', '500.1760912590557,1'],
	['e1.2e10', '12000000000,1'],
	['e1.235e56,789', '56789.091666957596,2'],
	['20.17609125905568,3', '20.17609125905568,3'],
	['naneinf', LARGEST_DOUBLE_TEXT],
	['inf', LARGEST_DOUBLE_TEXT],
	['Infinity', LARGEST_DOUBLE_TEXT],
	['1e400', '400,1'],
	['1e+400', '400,1'],
	['ee1.2e10', '12000000000,2'],
	['e12#34#56', TOP_SCORE],
	['10##5', TOP_SCORE],
	['-5', '0'],
	['nan', LARGEST_DOUBLE_TEXT],
	['NaN', LARGEST_DOUBLE_TEXT],
	['infinity', LARGEST_DOUBLE_TEXT],
	['-inf', '0'],
	['banana', '0'],
	['', '0'],
]

describe('legacy score text', () => {
	for (const [text, want] of LEGACY_VECTORS) {
		it(`${JSON.stringify(text)} gives ${want.slice(0, 24)}`, () => {
			expect(parseLegacyScore(text)).toBe(want)
		})
	}

	it('reads a number and refuses anything else', () => {
		expect(parseLegacyScore(250)).toBe('250')
		expect(parseLegacyScore(-1)).toBe('0')
		expect(parseLegacyScore(null)).toBe('0')
		expect(parseLegacyScore({})).toBe('0')
	})
})

describe('score as a double', () => {
	it('is exact below 1e308 and Infinity above', () => {
		expect(scoreToNumber('0')).toBe(0)
		expect(scoreToNumber('300')).toBe(300)
		expect(scoreToNumber('150000000000')).toBe(1.5e11)
		expect(scoreToNumber('300,1') / 1e300).toBeCloseTo(1, 5)
		expect(scoreToNumber('400,1')).toBe(Infinity)
		expect(scoreToNumber('20,2')).toBe(Infinity)
		expect(scoreToNumber(TOP_SCORE)).toBe(Infinity)
		expect(scoreToNumber('x')).toBe(0)
	})
})
