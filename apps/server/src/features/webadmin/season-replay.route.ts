import { Router } from 'express'
import { getSeasonForReplay } from '../../infrastructure/gateways/rating.gateway.js'
import { AppError } from '../../shared/utils/errors.js'
import { requireOwner } from '../../shared/utils/require-owner.js'
import { replaySeason } from '../ratings/season-replay.service.js'

// Owner-only dry run: replays the current Season's ranked games under the
// current rating rules and returns each player's rating before and after.
// Writes nothing.
const router = Router()

router.post('/ratings/season-replay', async (req, res, next) => {
	try {
		await requireOwner(req)
		const season = await getSeasonForReplay()
		if (!season) throw new AppError('There is no season to replay', 409)
		const result = await replaySeason(season.startedAt)
		if (!result.ok) {
			throw new AppError(`Nakama did not run the replay: ${result.error}`, 503)
		}
		res.json({
			season: { id: season.id, name: season.name, startedAt: season.startedAt },
			...result.value,
		})
	} catch (err) {
		next(err)
	}
})

export default router
