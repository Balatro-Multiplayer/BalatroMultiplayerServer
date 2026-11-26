import { Router } from 'express'
import { db } from '../../infrastructure/db/index.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import {
	clearRankedCocktail,
	getRankedCocktail,
	setRankedCocktail,
} from '../../infrastructure/gateways/ranked-cocktail.gateway.js'
import { recordStaffAction } from '../../infrastructure/gateways/staff-log.gateway.js'
import { parseReason } from '../../shared/staff-log/actions.js'
import { AppError } from '../../shared/utils/errors.js'
import { parseRecipe } from '../ranked-cocktail/recipe.js'

// The Cocktail deck Ranked plays. Admin only: the router is mounted behind
// the admin guard (webadmin.route.ts). Saves reload the config, which pushes
// the recipe to Nakama, and go in the staff log.
const router = Router()

router.get('/ranked-cocktail', async (_req, res, next) => {
	try {
		res.json({ recipe: await getRankedCocktail() })
	} catch (err) {
		next(err)
	}
})

router.put('/ranked-cocktail', async (req, res, next) => {
	try {
		const parsed = parseRecipe(req.body)
		if (!parsed.ok) throw new AppError(parsed.message, 400)
		const reason = parseReason((req.body as { reason?: unknown }).reason)
		if (!reason.ok) throw new AppError(reason.message, 400)
		const before = await getRankedCocktail()
		await db.transaction(async (tx) => {
			await setRankedCocktail(tx, parsed.recipe)
			await recordStaffAction(tx, {
				staff: { playerId: req.player!.playerId, role: 'admin' },
				action: 'ranked_cocktail_edit',
				reason: reason.reason,
				detail: { before, after: parsed.recipe },
			})
		})
		await loadConfigFromDb()
		res.json({ recipe: parsed.recipe })
	} catch (err) {
		next(err)
	}
})

// Back to the mod's built-in recipe.
router.delete('/ranked-cocktail', async (req, res, next) => {
	try {
		const reason = parseReason((req.body as { reason?: unknown })?.reason)
		if (!reason.ok) throw new AppError(reason.message, 400)
		const before = await getRankedCocktail()
		await db.transaction(async (tx) => {
			await clearRankedCocktail(tx)
			await recordStaffAction(tx, {
				staff: { playerId: req.player!.playerId, role: 'admin' },
				action: 'ranked_cocktail_edit',
				reason: reason.reason,
				detail: { before, after: null },
			})
		})
		await loadConfigFromDb()
		res.json({ recipe: null })
	} catch (err) {
		next(err)
	}
})

export default router
