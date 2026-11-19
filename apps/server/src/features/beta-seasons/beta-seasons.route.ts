// Beta Seasons: read-only boards and player history from the ranked seasons
// of the Discord queue era. A legacy player shows as their linked account when
// one has the same Discord account linked, else by the legacy name.
import { Router } from 'express'
import type { IBetaSeasonsRepository } from '../../contracts/IBetaSeasons.js'
import { optionalAuthenticate } from '../../middleware/authenticate.js'
import { AppError } from '../../shared/utils/errors.js'
import { MAX_PAGE, queryInt } from '../../shared/utils/query-int.js'
import { createTtlCache } from '../../shared/utils/ttl-cache.js'

// The seasons never change after the import; the cache only spares the counts.
const SEASONS_TTL_MS = 10 * 60 * 1000

export interface BetaSeasonsRouterDeps {
	betaSeasonsRepository: IBetaSeasonsRepository
}

function boardParams(query: Record<string, unknown>) {
	const { modId, gameMode } = query
	if (!modId || typeof modId !== 'string')
		throw new AppError('Missing modId', 400)
	if (!gameMode || typeof gameMode !== 'string')
		throw new AppError('Missing gameMode', 400)
	return { modId, gameMode }
}

function seasonParam(raw: unknown): number {
	const season = Number(raw)
	if (!Number.isInteger(season) || season < 1)
		throw new AppError('Invalid season', 400)
	return season
}

export function createBetaSeasonsRouter({
	betaSeasonsRepository: repo,
}: BetaSeasonsRouterDeps): Router {
	const router = Router()
	const getSeasons = createTtlCache(() => repo.listSeasons(), SEASONS_TTL_MS)

	router.get('/', async (_req, res, next) => {
		try {
			res.json({ seasons: await getSeasons(Date.now()) })
		} catch (err) {
			next(err)
		}
	})

	router.get('/:season/leaderboard', async (req, res, next) => {
		try {
			const season = seasonParam(req.params.season)
			const { modId, gameMode } = boardParams(req.query)
			const page = queryInt(req.query.page, 1, 1, MAX_PAGE)
			const pageSize = queryInt(req.query.pageSize, 100, 1, 200)
			const search =
				typeof req.query.search === 'string' ? req.query.search.trim() : ''
			const q = { season, modId, gameMode, term: search ? `%${search}%` : null }
			const [total, entries] = await Promise.all([
				repo.countBoard(q),
				repo.boardPage(q, pageSize, (page - 1) * pageSize),
			])
			res.json({
				season,
				modId,
				gameMode,
				page,
				pageSize,
				total,
				totalPages: Math.max(1, Math.ceil(total / pageSize)),
				entries,
			})
		} catch (err) {
			next(err)
		}
	})

	// A player with no Discord account linked has no Beta Season history yet.
	router.get('/players/:id', async (req, res, next) => {
		try {
			const hash = await repo.discordHashOf(req.params.id)
			res.json({
				linked: hash !== null,
				standings: hash ? await repo.standingsOf(hash) : [],
			})
		} catch (err) {
			next(err)
		}
	})

	// A game links to its legacy game log when the log is shared, or when the
	// player is looking at their own games.
	router.get(
		'/players/:id/games',
		optionalAuthenticate,
		async (req, res, next) => {
			try {
				const season = seasonParam(req.query.season)
				const { modId, gameMode } = boardParams(req.query)
				const page = queryInt(req.query.page, 1, 1, MAX_PAGE)
				const pageSize = queryInt(req.query.pageSize, 25, 1, 100)
				const playerId = String(req.params.id)
				const hash = await repo.discordHashOf(playerId)
				if (!hash) {
					res.json({ page, pageSize, total: 0, totalPages: 1, games: [] })
					return
				}
				const q = {
					discordIdHash: hash,
					season,
					modId,
					gameMode,
					ownView: req.player?.playerId === playerId,
				}
				const [total, games] = await Promise.all([
					repo.countGames(q),
					repo.gamesPage(q, pageSize, (page - 1) * pageSize),
				])
				res.json({
					page,
					pageSize,
					total,
					totalPages: Math.max(1, Math.ceil(total / pageSize)),
					games,
				})
			} catch (err) {
				next(err)
			}
		},
	)

	return router
}
