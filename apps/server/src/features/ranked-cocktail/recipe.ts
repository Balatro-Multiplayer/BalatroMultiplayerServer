// The Cocktail deck Ranked plays: a name and one to three distinct deck keys
// (the mod's PVP.receive_cocktail_recipe accepts the same shape, and refuses a
// key the player's game does not know), or random: the mod rolls three decks
// for every game, under this name. A mod from before random falls back to its
// built-in recipe (it needs decks).
export type CocktailRecipe =
	| { name: string; decks: string[] }
	| { name: string; random: true }

export const MAX_COCKTAIL_DECKS = 3
export const MAX_COCKTAIL_NAME = 64
const DECK_KEY = /^b_[a-z0-9_]{1,60}$/

export type RecipeCheck =
	| { ok: true; recipe: CocktailRecipe }
	| { ok: false; message: string }

export function parseRecipe(body: unknown): RecipeCheck {
	const { name, decks, random } = (body ?? {}) as {
		name?: unknown
		decks?: unknown
		random?: unknown
	}
	if (typeof name !== 'string' || !name.trim())
		return { ok: false, message: 'A name is required' }
	if (name.trim().length > MAX_COCKTAIL_NAME)
		return {
			ok: false,
			message: `The name is over ${MAX_COCKTAIL_NAME} characters`,
		}
	if (random !== undefined && typeof random !== 'boolean')
		return { ok: false, message: 'random must be true or false' }
	if (random === true) {
		if (decks !== undefined && !(Array.isArray(decks) && decks.length === 0))
			return { ok: false, message: 'A random Cocktail has no decks' }
		return { ok: true, recipe: { name: name.trim(), random: true } }
	}
	if (
		!Array.isArray(decks) ||
		decks.length < 1 ||
		decks.length > MAX_COCKTAIL_DECKS
	)
		return {
			ok: false,
			message: `Pick one to ${MAX_COCKTAIL_DECKS} decks`,
		}
	if (!decks.every((d) => typeof d === 'string' && DECK_KEY.test(d)))
		return { ok: false, message: 'Not a deck key' }
	if (new Set(decks).size !== decks.length)
		return { ok: false, message: 'Each deck can be picked once' }
	if (decks.includes('b_mp_cocktail'))
		return { ok: false, message: 'The Cocktail deck cannot be in a Cocktail' }
	return { ok: true, recipe: { name: name.trim(), decks: decks as string[] } }
}
