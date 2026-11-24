import { eq } from 'drizzle-orm'
import type { CocktailRecipe } from '../../features/ranked-cocktail/recipe.js'
import type { DbExecutor } from '../db/executor.js'
import { db } from '../db/index.js'
import { rankedCocktail } from '../db/schema.js'

// The recipe Ranked plays, or null when none is set (the mod's own applies).
export async function getRankedCocktail(
	exec: DbExecutor = db,
): Promise<CocktailRecipe | null> {
	const [row] = await exec
		.select()
		.from(rankedCocktail)
		.where(eq(rankedCocktail.id, 1))
	if (!row) return null
	return row.random
		? { name: row.name, random: true }
		: { name: row.name, decks: row.decks }
}

// The row's columns for a recipe (a random one keeps no decks).
function columnsOf(recipe: CocktailRecipe) {
	return 'random' in recipe
		? { name: recipe.name, decks: [], random: true }
		: { name: recipe.name, decks: recipe.decks, random: false }
}

export async function setRankedCocktail(
	exec: DbExecutor,
	recipe: CocktailRecipe,
): Promise<void> {
	await exec
		.insert(rankedCocktail)
		.values({ id: 1, ...columnsOf(recipe) })
		.onConflictDoUpdate({
			target: rankedCocktail.id,
			set: { ...columnsOf(recipe), updatedAt: new Date() },
		})
}

export async function clearRankedCocktail(exec: DbExecutor): Promise<void> {
	await exec.delete(rankedCocktail).where(eq(rankedCocktail.id, 1))
}
