import { describe, expect, it } from 'vitest'
import { MAX_PAGE, queryInt } from '../../shared/utils/query-int.js'

describe('queryInt', () => {
	it('uses the fallback for anything that is not one finite number', () => {
		for (const raw of [undefined, '', '  ', 'abc', 'NaN', '1e400', 'Infinity', ['1', '2'], { a: '1' }, 5]) {
			expect(queryInt(raw, 25, 1, 100)).toBe(25)
		}
	})

	it('clamps to [min, max] and drops fractions', () => {
		expect(queryInt('0', 25, 1, 100)).toBe(1)
		expect(queryInt('-7', 25, 1, 100)).toBe(1)
		expect(queryInt('100000', 25, 1, 100)).toBe(100)
		expect(queryInt('1.9', 25, 1, 100)).toBe(1)
		expect(queryInt('42', 25, 1, 100)).toBe(42)
		expect(queryInt(' 7 ', 25, 1, 100)).toBe(7)
	})

	it('never returns NaN, which drizzle .limit() would treat as "no limit"', () => {
		for (const raw of ['abc', '1e400', '-Infinity', 'x1']) {
			expect(Number.isNaN(queryInt(raw, 25, 1, 100))).toBe(false)
		}
	})

	it('keeps the largest offset a safe integer', () => {
		expect(Number.isSafeInteger((queryInt('1e300', 1, 1, MAX_PAGE) - 1) * 500)).toBe(true)
		expect(queryInt('1e300', 1, 1, MAX_PAGE)).toBe(MAX_PAGE)
	})
})
