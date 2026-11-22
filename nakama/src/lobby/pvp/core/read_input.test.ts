import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type InputFields, readInput } from './read_input'

const SPEC = {
	count: { type: 'whole', max: 100 },
	place: { type: 'text', max: 5 },
	on: { type: 'flag' },
	team: { type: 'oneOf', values: ['A', 'B'] },
	score: { type: 'score' },
	spent: { type: 'whole', nullable: true },
} as const satisfies InputFields

const GOOD = {
	count: 7,
	place: 'shop',
	on: true,
	team: 'A',
	score: '1500',
	spent: null,
}

describe('readInput', () => {
	it('returns the typed body of a good one', () => {
		const body = readInput(SPEC, GOOD)
		expect(body).toEqual(GOOD)
		const typed: {
			count: number
			team: 'A' | 'B'
			spent: number | null
		} | null = body
		expect(typed?.count).toBe(7)
	})

	it('takes a number and a text exactly at their max', () => {
		const atMax = { ...GOOD, count: 100, place: 'abcde' }
		expect(readInput(SPEC, atMax)).toEqual(atMax)
	})

	it.each<[string, { [field: string]: unknown }]>([
		['a missing field', { ...GOOD, count: undefined }],
		['an unknown field', { ...GOOD, extra: 1 }],
		['a number above its max', { ...GOOD, count: 101 }],
		['a negative number', { ...GOOD, count: -1 }],
		['a fraction', { ...GOOD, count: 1.5 }],
		['NaN', { ...GOOD, count: Number.NaN }],
		['Infinity', { ...GOOD, spent: Number.POSITIVE_INFINITY }],
		['a number beyond the safe integers', { ...GOOD, spent: 2 ** 53 }],
		['a number as text', { ...GOOD, count: '7' }],
		['a number as a text field', { ...GOOD, place: 1 }],
		['text over its max', { ...GOOD, place: 'toolong' }],
		['empty text', { ...GOOD, place: '' }],
		['a flag as a number', { ...GOOD, on: 1 }],
		['a value outside oneOf', { ...GOOD, team: 'C' }],
		['an inherited name for oneOf', { ...GOOD, team: 'constructor' }],
		['a score that is not a score', { ...GOOD, score: 'lots' }],
		['a score as a number', { ...GOOD, score: 1500 }],
		['null where null is not allowed', { ...GOOD, count: null }],
		['a nullable field that is missing', { ...GOOD, spent: undefined }],
	])('refuses %s', (_name, body) => {
		expect(readInput(SPEC, body)).toBeNull()
	})

	it.each<[string, unknown]>([
		['null', null],
		['an array', []],
		['a string', 'x'],
		['undefined', undefined],
	])('refuses %s as a body', (_name, body) => {
		expect(readInput(SPEC, body)).toBeNull()
	})

	it('refuses a __proto__ field in JSON', () => {
		expect(readInput({}, JSON.parse('{"__proto__": 1}'))).toBeNull()
	})

	describe('a free record', () => {
		const spec = {
			data: { type: 'record', maxKeys: 3, maxKeyLength: 6, maxSize: 40 },
		} as const satisfies InputFields

		it('is read as sent, with any names and a text, number or flag each', () => {
			const data = { set: 'tag_a', cost: 2.5, on: false }
			expect(readInput(spec, { data })).toEqual({ data })
			expect(readInput(spec, { data: {} })).toEqual({ data: {} })
		})

		it('reads an empty list as an empty record, and no other list', () => {
			expect(readInput(spec, { data: [] })).toEqual({ data: {} })
			expect(readInput(spec, { data: [[]] })).toBeNull()
			expect(readInput(spec, { data: [{}] })).toBeNull()
		})

		it.each<[string, unknown]>([
			['too many keys', { a: 1, b: 2, c: 3, d: 4 }],
			['a key too long', { toolong: 1 }],
			['a nested table', { a: { b: 1 } }],
			['a list', { a: [1] }],
			['a null', { a: null }],
			['a number that is not finite', { a: Number.POSITIVE_INFINITY }],
			['an array as the record', [1]],
			['null as the record', null],
			['__proto__ as a key', JSON.parse('{"__proto__": 1}')],
		])('refuses %s', (_name, data) => {
			expect(readInput(spec, { data })).toBeNull()
		})

		it('refuses a __proto__ key that is short enough, and keeps every other key', () => {
			const roomy = {
				data: { type: 'record', maxKeys: 3, maxKeyLength: 20, maxSize: 100 },
			} as const satisfies InputFields
			expect(
				readInput(roomy, { data: JSON.parse('{"__proto__": 1}') }),
			).toBeNull()
			expect(
				readInput(roomy, { data: JSON.parse('{"a": 1, "__proto__": "x"}') }),
			).toBeNull()
			expect(readInput(roomy, { data: { proto: 1 } })).toEqual({
				data: { proto: 1 },
			})
		})

		it('takes a record exactly at the key, key length and size limits', () => {
			const keys = { aaaaaa: 1, bbbbbb: 2, cccccc: 3 }
			expect(readInput(spec, { data: keys })).toEqual({ data: keys })
			const exact = { a: 'x'.repeat(32) }
			expect(JSON.stringify(exact)).toHaveLength(40)
			expect(readInput(spec, { data: exact })).toEqual({ data: exact })
			expect(readInput(spec, { data: { a: 'x'.repeat(33) } })).toBeNull()
		})

		it.each<[string, { [name: string]: string }, boolean]>([
			['a key of six ASCII letters', { abcdef: 'x' }, true],
			['a key of seven ASCII letters', { abcdefg: 'x' }, false],
			['a key of two three-byte letters (six bytes)', { '€€': 'x' }, true],
			['a key of three three-byte letters (nine bytes)', { '€€€': 'x' }, false],
			['a key of five two-byte letters (ten bytes)', { ééééé: 'x' }, false],
			['a value one byte over, in ASCII', { a: 'x'.repeat(40 - 7) }, false],
			[
				'a three-byte value that fits by letters but not by bytes',
				{ a: '€'.repeat(11) },
				false,
			],
			['a three-byte value that fits by bytes', { a: '€'.repeat(10) }, true],
		])('counts UTF-8 bytes: %s', (_name, data, accepted) => {
			expect(readInput(spec, { data }) !== null).toBe(accepted)
		})
	})

	it('reads a nested object and refuses a bad inner field', () => {
		const spec = {
			stats: {
				type: 'object',
				fields: { rerollCount: { type: 'whole' } },
			},
		} as const satisfies InputFields
		expect(readInput(spec, { stats: { rerollCount: 2 } })).toEqual({
			stats: { rerollCount: 2 },
		})
		expect(readInput(spec, { stats: { rerollCount: -2 } })).toBeNull()
		expect(readInput(spec, { stats: { rerollCount: 2, more: 1 } })).toBeNull()
		expect(readInput(spec, { stats: null })).toBeNull()
	})

	it('gives a score as the score rule reads it', () => {
		const spec = { score: { type: 'score' } } as const satisfies InputFields
		expect(readInput(spec, { score: '15' })).toEqual({ score: '15' })
		expect(readInput(spec, { score: '0015' })).toBeNull()
	})

	it('an empty spec takes only an empty body', () => {
		expect(readInput({}, {})).toEqual({})
		expect(readInput({}, { a: 1 })).toBeNull()
	})

	it('never throws and never accepts a body with a field the spec lacks', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const body = readInput(SPEC, value)
				if (body !== null)
					expect(Object.keys(body).sort()).toEqual(Object.keys(SPEC).sort())
			}),
		)
	})

	it('reads every body built from legal values, unchanged', () => {
		fc.assert(
			fc.property(
				fc.record({
					count: fc.integer({ min: 0, max: 100 }),
					place: fc.string({ minLength: 1, maxLength: 5 }),
					on: fc.boolean(),
					team: fc.constantFrom('A', 'B'),
					score: fc.nat().map(String),
					spent: fc.option(fc.nat(), { nil: null }),
				}),
				(body) => {
					expect(readInput(SPEC, body)).toEqual(body)
				},
			),
		)
	})
})
