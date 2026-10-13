import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { env } from '../../env.js'
import * as banGateway from '../../infrastructure/gateways/ban.gateway.js'
import * as muteGateway from '../../infrastructure/gateways/mute.gateway.js'
import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { AppError } from '../../shared/utils/errors.js'
import { createPlayerSyncService, type PlayerSyncService } from './player-sync.service.js'

// Routes only Nakama calls (nakama/src/express.ts), guarded by the shared
// INTERNAL_API_KEY. With no key configured every request is refused.
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
	const sent = req.headers['x-bmp-internal-key']
	if (!env.INTERNAL_API_KEY || typeof sent !== 'string') {
		res.status(401).json({ error: 'Missing internal key' })
		return
	}
	const expected = Buffer.from(env.INTERNAL_API_KEY)
	const actual = Buffer.from(sent)
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		res.status(403).json({ error: 'Bad internal key' })
		return
	}
	next()
}

const STEAM_ID = /^\d{1,20}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RESOLVE = 500

function defaultSyncService(): PlayerSyncService {
	return createPlayerSyncService({ players: playerGateway, bans: banGateway, mutes: muteGateway })
}

export function createInternalNakamaRouter(sync: PlayerSyncService = defaultSyncService()) {
	const router = Router()
	router.use(requireInternalKey)

	router.post('/ping', (_req, res) => {
		res.json({ ok: true })
	})

	// {steamId, nakamaUserId, steamName} -> PlayerSync. Called once per
	// Nakama account, at its first session_init.
	router.post('/player-sync', async (req, res, next) => {
		try {
			const { steamId, nakamaUserId, steamName } = req.body ?? {}
			if (typeof steamId !== 'string' || !STEAM_ID.test(steamId)) throw new AppError('Bad steamId', 400)
			if (typeof nakamaUserId !== 'string' || !UUID.test(nakamaUserId)) throw new AppError('Bad nakamaUserId', 400)
			const name = typeof steamName === 'string' ? steamName.slice(0, 64) : ''
			res.json(await sync.syncPlayer({ steamId, nakamaUserId, steamName: name }))
		} catch (err) {
			next(err)
		}
	})

	// {playerIds} -> {resolved: {[playerId]: nakamaUserId}}: legacy mutes of
	// players who have since logged in to Nakama.
	router.post('/resolve-players', async (req, res, next) => {
		try {
			const ids = req.body?.playerIds
			if (!Array.isArray(ids) || ids.length > MAX_RESOLVE || !ids.every((id) => typeof id === 'string'))
				throw new AppError('Bad playerIds', 400)
			const found = await playerGateway.findNakamaUserIds(ids)
			res.json({ resolved: Object.fromEntries(found) })
		} catch (err) {
			next(err)
		}
	})

	return router
}
