import { describe, expect, it } from 'vitest'
import { partitionTeams } from './teams'

describe('partitionTeams', () => {
	it('keeps every group on one team', () => {
		const split = partitionTeams([['a', 'b'], ['c'], ['d']])
		expect(split).toEqual({ ok: true, value: [['a', 'b'], ['c', 'd']] })
		const two = partitionTeams([['s1'], ['a', 'b'], ['s2'], ['c', 'd']])
		expect(two).toEqual({ ok: true, value: [['a', 'b', 's1'], ['c', 'd', 's2']] })
	})

	it('finds a split that needs the right combination', () => {
		const split = partitionTeams([['a', 'b', 'c'], ['d', 'e'], ['f', 'g'], ['h']])
		expect(split.ok).toBe(true)
		if (!split.ok) return
		const [x, y] = split.value
		expect(x).toHaveLength(4)
		expect(y).toHaveLength(4)
		for (const group of [['a', 'b', 'c'], ['d', 'e'], ['f', 'g']])
			expect(group.every((id) => x.includes(id)) || group.every((id) => y.includes(id))).toBe(true)
	})

	it('refuses an odd count and an unsplittable one', () => {
		expect(partitionTeams([['a', 'b'], ['c']])).toEqual({ ok: false, error: 'odd_players' })
		expect(partitionTeams([['a', 'b', 'c'], ['d']])).toEqual({ ok: false, error: 'groups_unsplittable' })
	})

	it('splits solo players alone', () => {
		expect(partitionTeams([['a'], ['b']])).toEqual({ ok: true, value: [['a'], ['b']] })
	})
})
