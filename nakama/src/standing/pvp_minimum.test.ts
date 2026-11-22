import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { belowMinimum } from './pvp_version'

describe('belowMinimum', () => {
	it.each([
		['1.0.5', '1.0.5', false],
		['1.0.6', '1.0.5', false],
		['1.1.0', '1.0.9', false],
		['2.0.0', '1.9.9', false],
		['1.0.4', '1.0.5', true],
		['1.0.9', '1.1.0', true],
		['1.9.9', '2.0.0', true],
		['1.10.0', '1.9.0', false],
		['1.9.0', '1.10.0', true],
		['0.0.0', '0.0.0', false],
	])('%s against minimum %s is below: %s', (version, minimum, below) => {
		expect(belowMinimum(version, minimum)).toBe(below)
	})

	it.each(['', 'UNK', '1.0', '1', 'v1.0.5', '1.0.5-beta', 'x.y.z', ' 1.0.5'])(
		'an unreadable version %j is below a minimum',
		(version) => {
			expect(belowMinimum(version, '1.0.0')).toBe(true)
		},
	)

	it('an unknown version (no seat, no report) is below a minimum', () => {
		expect(belowMinimum(undefined, '1.0.0')).toBe(true)
	})

	it('an unknown version is let in when there is no minimum', () => {
		expect(belowMinimum(undefined, '')).toBe(false)
	})

	it.each(['', '1.0.5', 'UNK', '1.0.5'])(
		'no minimum (%j) lets every version in',
		(version) => {
			expect(belowMinimum(version, '')).toBe(false)
		},
	)

	it('agrees with comparing the three numbers in order', () => {
		const part = fc.nat({ max: 30 })
		fc.assert(
			fc.property(
				fc.tuple(part, part, part),
				fc.tuple(part, part, part),
				(a, b) => {
					const lower =
						a[0] !== b[0]
							? a[0] < b[0]
							: a[1] !== b[1]
								? a[1] < b[1]
								: a[2] < b[2]
					expect(belowMinimum(a.join('.'), b.join('.'))).toBe(lower)
				},
			),
		)
	})
})
