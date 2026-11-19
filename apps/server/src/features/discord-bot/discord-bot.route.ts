import { DISCORD_BOT_MAX_IDS, DISCORD_ID_PATTERN, boardName } from '@bmp/types'
import { type NextFunction, Router } from 'express'
import { env } from '../../env.js'
import * as standingsGateway from '../../infrastructure/gateways/discord-standings.gateway.js'
import { getCurrentSeason } from '../../infrastructure/gateways/rating.gateway.js'
import { requireSharedKey } from '../../middleware/require-shared-key.js'
import { AppError } from '../../shared/utils/errors.js'
import { hashProviderId } from '../../shared/utils/hash.js'
import {
	NoActiveSeasonError,
	type StandingsService,
	createStandingsService,
} from './standings.service.js'

// Routes only the Discord rank-role bot (apps/discord-bot) calls, guarded by
// its own DISCORD_BOT_API_KEY. With no key configured every request is refused.

export const MAX_TOP_N = 200

function defaultStandingsService(): StandingsService {
	return createStandingsService({
		hashDiscordId: hashProviderId,
		currentSeasonId: async () => (await getCurrentSeason())?.id ?? null,
		previousSeasonId: standingsGateway.previousSeasonId,
		playerIdsByDiscordIdHash: standingsGateway.playerIdsByDiscordIdHash,
		inBoardSnapshot: standingsGateway.inBoardSnapshot,
		now: () => new Date(),
	})
}

function readBoardAndTop(body: Record<string, unknown>) {
	const { modId, gameMode, topN } = body
	if (
		typeof modId !== 'string' ||
		typeof gameMode !== 'string' ||
		boardName(modId, gameMode) === undefined
	)
		throw new AppError('Unknown board', 400)
	if (
		typeof topN !== 'number' ||
		!Number.isInteger(topN) ||
		topN < 0 ||
		topN > MAX_TOP_N
	)
		throw new AppError('Bad topN', 400)
	return { modId, gameMode, topN }
}

// Between seasons: the bot changes nothing and tries again later.
function seasonErrors(err: unknown, next: NextFunction) {
	next(
		err instanceof NoActiveSeasonError ? new AppError(err.message, 503) : err,
	)
}

export function createDiscordBotRouter(
	service: Pick<
		StandingsService,
		'standings' | 'changes'
	> = defaultStandingsService(),
) {
	const router = Router()
	router.use(requireSharedKey(() => env.DISCORD_BOT_API_KEY))

	// {modId, gameMode, topN, discordIds} -> StandingsAnswer for the current
	// season of that board.
	router.post('/standings', async (req, res, next) => {
		try {
			const board = readBoardAndTop(req.body ?? {})
			const { discordIds } = req.body
			if (
				!Array.isArray(discordIds) ||
				discordIds.length > DISCORD_BOT_MAX_IDS ||
				!discordIds.every(
					(id) => typeof id === 'string' && DISCORD_ID_PATTERN.test(id),
				)
			)
				throw new AppError('Bad discordIds', 400)
			res.json(await service.standings({ ...board, discordIds }))
		} catch (err) {
			seasonErrors(err, next)
		}
	})

	// {modId, gameMode, topN, since} -> ChangesAnswer: who played since the
	// last call, and the current top N. The bot polls it to update roles
	// right after matches.
	router.post('/changes', async (req, res, next) => {
		try {
			const board = readBoardAndTop(req.body ?? {})
			const { since } = req.body
			if (
				since !== null &&
				(typeof since !== 'string' || Number.isNaN(Date.parse(since)))
			)
				throw new AppError('Bad since', 400)
			res.json(await service.changes({ ...board, since }))
		} catch (err) {
			seasonErrors(err, next)
		}
	})

	return router
}
