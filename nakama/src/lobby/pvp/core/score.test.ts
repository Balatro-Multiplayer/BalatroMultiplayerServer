// Parity with lib/score.lua: every `"side":"server"` row of the shared fixture
// (tests/fixtures/score_cases.json in the PvP repo), plus laws.
import { readFileSync } from 'node:fs'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	compare,
	compareBlindScore,
	equal,
	fromGameValue,
	greater,
	parse,
	sum,
} from './score'

interface Row {
	fn: string
	name: string
	args: unknown[]
	out: unknown
	side: 'server' | 'client'
}

const rows: Row[] = JSON.parse(
	readFileSync(new URL('../testing/score_cases.json', import.meta.url), 'utf8'),
)
// A compare or a sum is only ever given canonical score text (callers refuse
// and normalize the rest), so the rows that feed it garbage, nil or a non-score are not run.
const isScoreText = (v: unknown): boolean =>
	typeof v === 'string' && parse(v) === v
const serverRows = rows
	.filter((r) => r.side === 'server')
	.filter((r) => r.fn !== 'or_zero')
	.filter((r) =>
		['compare', 'greater', 'equal'].includes(r.fn)
			? r.args.every(isScoreText)
			: r.fn !== 'sum' || (r.args[0] as unknown[]).every(isScoreText),
	)

// The table arguments of the fixture are plain JSON arrays.
function run(row: Row): unknown {
	const [first, second] = row.args
	switch (row.fn) {
		case 'parse':
			return parse(first)
		case 'compare':
			return compare(first as string, second as string)
		case 'greater':
			return greater(first as string, second as string)
		case 'equal':
			return equal(first as string, second as string)
		case 'from_game_value':
			return fromGameValue(first as number)
		case 'sum':
			return sum(first as string[])
		default:
			throw new Error(`unknown fixture fn ${row.fn}`)
	}
}

describe('score_cases.json (server rows)', () => {
	it('runs the score-text server rows', () => {
		expect(serverRows).toHaveLength(65)
	})
	it.each(serverRows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
		expect(run(row)).toEqual(row.out)
	})
})

// Boundary values (equal texts, plain and array scores, mixed lengths) beside random ones.
const BOUNDARY_SCORES = [
	'0',
	'1',
	'9',
	'10',
	'999999',
	'5,3',
	'1,1',
	'2,5',
	'999999,999999',
	'1,2,3',
]
const randomScore = fc
	.array(fc.integer({ min: 1, max: 999_999 }), { minLength: 1, maxLength: 3 })
	.map((parts) => parts.join(','))
const scoreText = fc.oneof(fc.constantFrom(...BOUNDARY_SCORES), randomScore)

// An unreported PvP blind score (null) ranks below every reported one and ties only another null.
describe('compareBlindScore', () => {
	it.each<[string, string | null, string | null, -1 | 0 | 1]>([
		['null and null tie', null, null, 0],
		['null is below a score', null, '5', -1],
		['null is below zero', null, '0', -1],
		['a score is above null', '5', null, 1],
		['zero is above null', '0', null, 1],
		['two scores compare by value', '9', '10', -1],
	])('%s', (_name, first, second, order) => {
		expect(compareBlindScore(first, second)).toBe(order)
	})
})

describe('score laws', () => {
	it('compare is antisymmetric and agrees with greater and equal', () => {
		fc.assert(
			fc.property(scoreText, scoreText, (first, second) => {
				expect(compare(first, second)).toBe(-compare(second, first) + 0)
				expect(greater(first, second)).toBe(compare(first, second) === 1)
				expect(equal(first, second)).toBe(compare(first, second) === 0)
			}),
		)
	})
	it('compare is transitive', () => {
		fc.assert(
			fc.property(scoreText, scoreText, scoreText, (first, second, third) => {
				if (compare(first, second) <= 0 && compare(second, third) <= 0)
					expect(compare(first, third)).toBeLessThanOrEqual(0)
			}),
		)
	})
	it('sum of plain integers is exact and order-independent', () => {
		fc.assert(
			fc.property(
				fc.array(fc.nat({ max: 1_000_000 }), { maxLength: 12 }),
				(numbers) => {
					const texts = numbers.map(String)
					const total = numbers.reduce((x, y) => x + y, 0)
					expect(sum(texts)).toBe(String(total))
					expect(sum([...texts].reverse())).toBe(sum(texts))
				},
			),
		)
	})
})
