import { boardName } from '@bmp/types'
import { Router } from 'express'
import { env } from '../../env.js'
import {
	BoardRebuildingError,
	readingStableBoard,
} from '../../infrastructure/db/board-lock.js'
import * as standingsGateway from '../../infrastructure/gateways/discord-standings.gateway.js'
import { getCurrentSeason } from '../../infrastructure/gateways/rating.gateway.js'
import { leaderboardPage } from '../../infrastructure/gateways/stats.gateway.js'
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

const DISCORD_ID = /^\d{17,20}$/
export const MAX_DISCORD_IDS = 1000
export const MAX_TOP_N = 200

function defaultStandingsService(): StandingsService {
	return createStandingsService({
		hashDiscordId: hashProviderId,
		currentSeasonId: async () => (await getCurrentSeason())?.id ?? null,
		previousSeasonId: standingsGateway.previousSeasonId,
		playerIdsByDiscordIdHash: standingsGateway.playerIdsByDiscordIdHash,
		boardRatings: standingsGateway.boardRatings,
		// The public leaderboard's own query (GET /api/stats/leaderboard), so
		// the top-N roles follow exactly the order players see.
		topOfBoard: async (board, n) =>
			(await leaderboardPage({ ...board, term: null }, n, 0)).map((r) => ({
				playerId: r.playerId,
				rank: r.rank,
			})),
		readingStableBoard,
	})
}

export function createDiscordBotRouter(
	service: StandingsService = defaultStandingsService(),
) {
	const router = Router()
	router.use(requireSharedKey(() => env.DISCORD_BOT_API_KEY))

	// {modId, gameMode, topN, discordIds} -> StandingsAnswer for the current
	// season of that board.
	router.post('/standings', async (req, res, next) => {
		try {
			const { modId, gameMode, topN, discordIds } = req.body ?? {}
			if (
				typeof modId !== 'string' ||
				typeof gameMode !== 'string' ||
				boardName(modId, gameMode) === undefined
			)
				throw new AppError('Unknown board', 400)
			if (!Number.isInteger(topN) || topN < 0 || topN > MAX_TOP_N)
				throw new AppError('Bad topN', 400)
			if (
				!Array.isArray(discordIds) ||
				discordIds.length > MAX_DISCORD_IDS ||
				!discordIds.every((id) => typeof id === 'string' && DISCORD_ID.test(id))
			)
				throw new AppError('Bad discordIds', 400)
			res.json(await service.standings({ modId, gameMode, topN, discordIds }))
		} catch (err) {
			// Both pass: the bot changes nothing and tries again on its next run.
			if (
				err instanceof NoActiveSeasonError ||
				err instanceof BoardRebuildingError
			) {
				next(new AppError(err.message, 503))
				return
			}
			next(err)
		}
	})

	return router
}
