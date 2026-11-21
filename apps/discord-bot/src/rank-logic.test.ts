import { describe, expect, it } from 'vitest'
import { EXPANDED, type Ladder } from './ladders.js'
import {
	leaderboardRoleFor,
	planRoleChanges,
	ratingRoleFor,
	rolesForLadder,
} from './rank-logic.js'

const seasons = { current: 3, previous: 2 }
const settled = (rating: number, rank: number | null = null) => ({
	current: { gamesPlayed: 40, rating, rank },
	previous: null,
})

describe('ratingRoleFor', () => {
	it.each([
		[100, 'stone'],
		[674, 'stone'],
		[675, 'steel'],
		[749, 'steel'],
		[750, 'gold'],
		[899, 'gold'],
		[900, 'lucky'],
		[1049, 'lucky'],
		[1050, 'glass'],
		[2000, 'glass'],
	])('%i -> %s', (rating, role) => {
		expect(ratingRoleFor(rating, EXPANDED.ratingRoles)).toBe(role)
	})

	it('is null below every cutoff', () => {
		expect(ratingRoleFor(10, [{ role: 'steel', min: 675 }])).toBeNull()
	})
})

describe('leaderboardRoleFor', () => {
	it.each([
		[1, 'negative'],
		[2, 'polychrome'],
		[3, 'polychrome'],
		[4, 'holographic'],
		[10, 'holographic'],
		[11, 'foil'],
		[50, 'foil'],
		[51, null],
		[null, null],
	])('#%s -> %s', (rank, role) => {
		expect(leaderboardRoleFor(rank, EXPANDED.leaderboardRoles)).toBe(role)
	})
})

describe('rolesForLadder', () => {
	it('gives an unlinked member nothing', () => {
		expect(rolesForLadder(EXPANDED, undefined, seasons)).toEqual([])
	})

	it('gives #1 one rating role and only Negative', () => {
		expect(rolesForLadder(EXPANDED, settled(1400, 1), seasons)).toEqual([
			'glass',
			'negative',
		])
	})

	it('gives a rating role alone outside the top 50', () => {
		expect(rolesForLadder(EXPANDED, settled(760, 300), seasons)).toEqual([
			'gold',
		])
	})

	it('waits for 5 games this season', () => {
		const four = {
			current: { gamesPlayed: 4, rating: 800, rank: null },
			previous: null,
		}
		const five = {
			current: { gamesPlayed: 5, rating: 800, rank: null },
			previous: null,
		}
		expect(rolesForLadder(EXPANDED, four, seasons)).toEqual([])
		expect(rolesForLadder(EXPANDED, five, seasons)).toEqual(['gold'])
	})

	it("keeps last season's rating role until 5 games this season", () => {
		const standing = {
			current: { gamesPlayed: 2, rating: 600, rank: 5 },
			previous: { gamesPlayed: 30, rating: 950 },
		}
		// No leaderboard role from the fallback: those follow the current board.
		expect(rolesForLadder(EXPANDED, standing, seasons)).toEqual(['lucky'])
		expect(
			rolesForLadder(
				EXPANDED,
				{ current: null, previous: standing.previous },
				seasons,
			),
		).toEqual(['lucky'])
	})

	it("reads last season's rating on last season's cutoffs", () => {
		const ladder: Ladder = {
			...EXPANDED,
			ratingRolesBySeason: {
				2: [
					{ role: 'stone', min: 0 },
					{ role: 'glass', min: 920 },
				],
			},
		}
		const standing = {
			current: null,
			previous: { gamesPlayed: 30, rating: 950 },
		}
		expect(rolesForLadder(ladder, standing, seasons)).toEqual(['glass'])
	})

	it('gives nothing without 5 games last season or this one', () => {
		const standing = {
			current: { gamesPlayed: 1, rating: 700, rank: null },
			previous: { gamesPlayed: 4, rating: 900 },
		}
		expect(rolesForLadder(EXPANDED, standing, seasons)).toEqual([])
	})

	it('gives nothing from previous data in the first season', () => {
		const standing = {
			current: null,
			previous: { gamesPlayed: 30, rating: 900 },
		}
		expect(
			rolesForLadder(EXPANDED, standing, { current: 1, previous: null }),
		).toEqual([])
	})
})

describe('planRoleChanges', () => {
	const managed = new Set(['gold', 'steel', 'foil'])

	it('adds and removes managed roles only', () => {
		expect(
			planRoleChanges(['steel', 'mod', 'booster'], ['gold', 'foil'], managed),
		).toEqual({
			add: ['gold', 'foil'],
			remove: ['steel'],
		})
	})

	it('strips every managed role from an unlinked member and nothing else', () => {
		expect(planRoleChanges(['gold', 'foil', 'mod'], [], managed)).toEqual({
			add: [],
			remove: ['gold', 'foil'],
		})
	})

	it('never adds a role outside the managed set', () => {
		expect(planRoleChanges([], ['mod'], managed)).toEqual({
			add: [],
			remove: [],
		})
	})

	it('changes nothing when roles already match', () => {
		expect(planRoleChanges(['gold', 'mod'], ['gold'], managed)).toEqual({
			add: [],
			remove: [],
		})
	})
})
