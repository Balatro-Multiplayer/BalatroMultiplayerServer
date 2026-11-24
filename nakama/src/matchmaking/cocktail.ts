// The Cocktail deck Ranked plays, set on the website and pushed in the server
// config. The mod asks for it when it queues for Ranked and puts it in the
// lobby metadata every player applies at game start. `recipe` is null when
// none is set: the mod then uses its built-in one.
import { readConfig } from '../config'
import { UNAUTHENTICATED, runtimeError } from '../errors'

// {} -> {recipe: {name, decks} | null}.
export function rpcCocktailRecipe(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	if (!ctx.userId) throw runtimeError(UNAUTHENTICATED, 'The Cocktail recipe needs a player session')
	return JSON.stringify({ recipe: readConfig(nk).rankedCocktail })
}
