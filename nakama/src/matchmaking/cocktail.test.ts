import { describe, expect, it } from 'vitest'
import { CONFIG_COLLECTION, CONFIG_KEY, cocktailRecipeOf, mergeConfig, DEFAULT_CONFIG } from '../config'
import { SYSTEM_USER_ID } from '../lobby/protocol'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { rpcCocktailRecipe } from './cocktail'

const RECIPE = { name: 'Sample Cocktail', decks: ['b_red', 'b_erratic', 'b_mp_orange'] }

describe('cocktailRecipeOf', () => {
	it('accepts one to three distinct deck keys', () => {
		expect(cocktailRecipeOf(RECIPE)).toEqual(RECIPE)
		expect(cocktailRecipeOf({ name: 'One', decks: ['b_red'] })).toEqual({ name: 'One', decks: ['b_red'] })
	})
	it('refuses anything else', () => {
		expect(cocktailRecipeOf(null)).toBeNull()
		expect(cocktailRecipeOf({ name: '', decks: ['b_red'] })).toBeNull()
		expect(cocktailRecipeOf({ name: 'x', decks: [] })).toBeNull()
		expect(cocktailRecipeOf({ name: 'x', decks: ['b_red', 'b_blue', 'b_black', 'b_green'] })).toBeNull()
		expect(cocktailRecipeOf({ name: 'x', decks: ['b_red', 'b_red'] })).toBeNull()
		expect(cocktailRecipeOf({ name: 'x', decks: ['Red Deck'] })).toBeNull()
		expect(cocktailRecipeOf({ name: 'x', decks: ['b_mp_cocktail'] })).toBeNull()
	})
})

describe('mergeConfig rankedCocktail', () => {
	it('sets, clears and ignores invalid pushes', () => {
		const set = mergeConfig(DEFAULT_CONFIG, { rankedCocktail: RECIPE })
		expect(set.rankedCocktail).toEqual(RECIPE)
		expect(mergeConfig(set, { rankedCocktail: { name: 'x', decks: [] } }).rankedCocktail).toEqual(RECIPE)
		expect(mergeConfig(set, { chatEnabled: true }).rankedCocktail).toEqual(RECIPE)
		expect(mergeConfig(set, { rankedCocktail: null }).rankedCocktail).toBeNull()
	})
})

describe('rpcCocktailRecipe', () => {
	it('answers the pushed recipe, or null when none is set', () => {
		const nk = fakeNk()
		const ask = () => JSON.parse(rpcCocktailRecipe(playerCtx('u1'), fakeLogger, nk as any, ''))
		expect(ask()).toEqual({ recipe: null })
		nk.storageWrite([
			{ collection: CONFIG_COLLECTION, key: CONFIG_KEY, userId: SYSTEM_USER_ID, value: { rankedCocktail: RECIPE } },
		])
		expect(ask()).toEqual({ recipe: RECIPE })
	})
	it('needs a player session', () => {
		expect(() => rpcCocktailRecipe({} as any, fakeLogger, fakeNk() as any, '')).toThrow()
	})
})
