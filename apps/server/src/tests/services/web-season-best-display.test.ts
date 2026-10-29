// The Web boards and player page show a season best through formatMetric.
// These texts are the display vectors of packages/types/src/big-score.test.ts
// and of the in-game suite suites/mpapi/big_score.lua, so the Web and the game
// give the same text for the same score.

import { describe, expect, it } from 'vitest'
import { formatMetric } from '../../../../web/src/lib/leaderboards'

const SAME_AS_GAME: [string, string][] = [
	// below 1e15
	['12345', '12,345'],
	['150000000000', '1.5e11'],
	// above 1e308
	['1234.5,1', '3.162e1,234'],
	// leading e levels
	['20,2', 'e1e20'],
	['20,3', 'ee1e20'],
	['20,5,1', 'e20#5#2'],
]

describe('Web season best display', () => {
	for (const [text, want] of SAME_AS_GAME) {
		it(`${text} -> ${want}`, () => {
			expect(formatMetric('score', text)).toBe(want)
		})
	}

	it('shows an old number score as the same score', () => {
		expect(formatMetric('score', 12345)).toBe('12,345')
		expect(formatMetric('score', 1.5e11)).toBe('1.5e11')
	})

	it('shows a dash for no score or malformed text', () => {
		expect(formatMetric('score', null)).toBe('-')
		expect(formatMetric('score', 'x')).toBe('-')
	})

	it('leaves time boards as m:ss.mmm', () => {
		expect(formatMetric('time', 61234)).toBe('1:01.234')
		expect(formatMetric('time', '61234')).toBe('1:01.234')
	})
})
