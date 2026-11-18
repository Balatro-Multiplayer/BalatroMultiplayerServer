import { Router } from 'express'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import {
	findModByIdOrFullName,
	setRankedVersion,
} from '../../infrastructure/gateways/mods.gateway.js'
import { parseReason } from '../../shared/staff-log/actions.js'
import { AppError } from '../../shared/utils/errors.js'
import { syncModRegistry } from '../mods/mods-sync.service.js'
import { logDeployAction, requireDeployToken } from './deploy-auth.js'
import { createRankedDeployRouter } from './ranked.route.js'

// Routes GitHub Actions call with the deploy token (ADR 0012). Add a route
// here only when an action needs it; every route reads a reason and logs it
// through logDeployAction.
export function createDeployRouter() {
	const router = Router()
	router.use(requireDeployToken)
	router.use('/ranked', createRankedDeployRouter())

	// {package: Thunderstore full name, version, reason}: pins the mod the way
	// the admin route does (download, hash, SMODS ids), then pushes the config.
	router.put('/pins', async (req, res, next) => {
		try {
			const { package: fullName, version } = (req.body ?? {}) as Record<
				string,
				unknown
			>
			if (typeof fullName !== 'string' || !fullName.trim())
				throw new AppError('package is required', 400)
			if (typeof version !== 'string' || !version.trim())
				throw new AppError('version is required', 400)
			const checked = parseReason((req.body as { reason?: unknown }).reason)
			if (!checked.ok) throw new AppError(checked.message, 400)

			const mod = await findModByIdOrFullName(fullName.trim())
			if (!mod) throw new AppError('Mod not found', 404)
			let result = await setRankedVersion(mod.id, version.trim())
			// A version published moments ago is not in the registry until the
			// sync runs (it shares an in-flight run), so sync once and look again.
			if (!result.ok && result.reason === 'version-not-found') {
				await syncModRegistry()
				result = await setRankedVersion(mod.id, version.trim())
			}
			if (!result.ok) {
				switch (result.reason) {
					case 'not-found':
						throw new AppError('Mod not found', 404)
					case 'version-not-found':
						throw new AppError('That version is not on Thunderstore yet', 400)
					case 'download-unresolvable':
						throw new AppError(
							"Couldn't resolve that version to a download right now, try again",
							400,
						)
					case 'hash-failed':
						throw new AppError("Couldn't compute a hash for that version", 400)
				}
			}
			await loadConfigFromDb()
			await logDeployAction({
				action: 'mod_pin',
				reason: checked.reason,
				detail: {
					modId: mod.id,
					old: { rankedVersion: mod.rankedVersion ?? null },
					new: { rankedVersion: version.trim() },
				},
			})
			res.json({ ok: true })
		} catch (err) {
			next(err)
		}
	})

	return router
}
