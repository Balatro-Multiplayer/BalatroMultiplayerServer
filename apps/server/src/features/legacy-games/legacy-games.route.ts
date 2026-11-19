import { Router } from 'express'
import { authenticateActive } from '../../middleware/authenticate-active.js'
import { optionalAuthenticate } from '../../middleware/authenticate.js'
import { AppError } from '../../shared/utils/errors.js'
import { MAX_PAGE, queryInt } from '../../shared/utils/query-int.js'
import type { LegacyGamesService } from './legacy-games.service.js'

// authenticateActive has run, so a player is always there.
function callerId(req: { player?: { playerId: string } }): string {
	if (!req.player) throw new AppError('Unauthorized', 401)
	return req.player.playerId
}

function gameId(raw: unknown): number {
	const id = Number(raw)
	if (!Number.isInteger(id) || id < 1) throw new AppError('Game not found', 404)
	return id
}

export function createLegacyGamesRouter(service: LegacyGamesService): Router {
	const router = Router()

	// The caller's own legacy games ("My Matches").
	router.get('/mine', authenticateActive, async (req, res, next) => {
		try {
			const page = queryInt(req.query.page, 1, 1, MAX_PAGE)
			const pageSize = queryInt(req.query.pageSize, 20, 1, 50)
			res.json(await service.listMine(callerId(req), page, pageSize))
		} catch (err) {
			next(err)
		}
	})

	// Open to anyone: the service answers 404 unless the viewer owns the game,
	// is a moderator, or the game is shared.
	router.get('/:id', optionalAuthenticate, async (req, res, next) => {
		try {
			res.json(
				await service.getGame(
					gameId(req.params.id),
					req.player?.playerId ?? null,
				),
			)
		} catch (err) {
			next(err)
		}
	})

	for (const [method, shared] of [
		['post', true],
		['delete', false],
	] as const) {
		router[method]('/:id/share', authenticateActive, async (req, res, next) => {
			try {
				await service.setShared(gameId(req.params.id), callerId(req), shared)
				res.json({ shared })
			} catch (err) {
				next(err)
			}
		})
	}

	return router
}
