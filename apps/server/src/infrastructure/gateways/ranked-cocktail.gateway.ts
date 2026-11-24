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
	return row ? { name: row.name, decks: row.decks } : null
}

export async function setRankedCocktail(
	exec: DbExecutor,
	recipe: CocktailRecipe,
): Promise<void> {
	await exec
		.insert(rankedCocktail)
		.values({ id: 1, ...recipe })
		.onConflictDoUpdate({
			target: rankedCocktail.id,
			set: { ...recipe, updatedAt: new Date() },
		})
}

export async function clearRankedCocktail(exec: DbExecutor): Promise<void> {
	await exec.delete(rankedCocktail).where(eq(rankedCocktail.id, 1))
}
