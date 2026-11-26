import { describe, expect, it } from 'vitest'
import { parseRecipe } from '../../features/ranked-cocktail/recipe.js'

describe('parseRecipe', () => {
	it('accepts a name and one to three distinct deck keys', () => {
		expect(parseRecipe({ name: '  Sample ', decks: ['b_red', 'b_mp_orange'] })).toEqual({
			ok: true,
			recipe: { name: 'Sample', decks: ['b_red', 'b_mp_orange'] },
		})
	})

	it('accepts a random one: a name, no decks', () => {
		expect(parseRecipe({ name: ' Mystery ', random: true })).toEqual({
			ok: true,
			recipe: { name: 'Mystery', random: true },
		})
		expect(parseRecipe({ name: 'Mystery', random: true, decks: [] }).ok).toBe(true)
		expect(parseRecipe({ name: 'Mystery', random: true, sameEveryTile: true })).toEqual({
			ok: true,
			recipe: { name: 'Mystery', random: true, sameEveryTile: true },
		})
		expect(parseRecipe({ name: 'Mystery', random: true, sameEveryTile: false })).toEqual({
			ok: true,
			recipe: { name: 'Mystery', random: true },
		})
		expect(parseRecipe({ name: 'x', random: false, decks: ['b_red'] })).toEqual({
			ok: true,
			recipe: { name: 'x', decks: ['b_red'] },
		})
	})

	it.each([
		['random with decks', { name: 'x', random: true, decks: ['b_red'] }],
		['random not a boolean', { name: 'x', random: 'yes', decks: ['b_red'] }],
		['random with no name', { name: '', random: true }],
		['same every tile on a fixed recipe', { name: 'x', decks: ['b_red'], sameEveryTile: true }],
		['same every tile not a boolean', { name: 'x', random: true, sameEveryTile: 1 }],
		['no name', { name: ' ', decks: ['b_red'] }],
		['a long name', { name: 'x'.repeat(65), decks: ['b_red'] }],
		['no decks', { name: 'x', decks: [] }],
		['four decks', { name: 'x', decks: ['b_red', 'b_blue', 'b_black', 'b_green'] }],
		['a repeat', { name: 'x', decks: ['b_red', 'b_red'] }],
		['a display name', { name: 'x', decks: ['Red Deck'] }],
		['the Cocktail itself', { name: 'x', decks: ['b_mp_cocktail'] }],
		['no body', undefined],
	])('refuses %s', (_label, body) => {
		expect(parseRecipe(body).ok).toBe(false)
	})
})
