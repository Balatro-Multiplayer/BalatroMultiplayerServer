import { Router } from 'express'
import {
	closeNakamaLobby,
	getNakamaLobby,
	kickFromNakamaLobby,
	listNakamaLobbies,
} from '../../infrastructure/nakama/moderation-sync.js'
import { AppError } from '../../shared/utils/errors.js'
import { getLobby, lobbies } from '../../state/index.js'
import type { PlayerSession } from '../../state/player.js'

const router = Router()

function matchesSearch(
	term: string,
	code: string,
	players: PlayerSession[],
): boolean {
	if (code.toLowerCase().includes(term)) return true
	return players.some(
		(p) =>
			p.steamName.toLowerCase().includes(term) ||
			p.discordUsername?.toLowerCase().includes(term) ||
			p.getDisplayName().toLowerCase().includes(term),
	)
}

router.get('/lobbies', async (req, res, next) => {
	try {
		const page = Math.max(1, Number(req.query.page ?? 1))
		const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)))
		const search =
			typeof req.query.search === 'string'
				? req.query.search.trim().toLowerCase()
				: ''

		const all = Array.from(lobbies.values())
			.filter(
				(lobby) =>
					!search ||
					matchesSearch(search, lobby.code, Array.from(lobby.players.values())),
			)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

		// Nakama's lobbies first: a code both servers use is the Nakama one
		// (kick and close act on it).
		const nakama = (await listNakamaLobbies())
			.filter((lobby) => !search || lobby.code.toLowerCase().includes(search))
			.map((lobby) => ({
				source: 'nakama' as const,
				code: lobby.code,
				modId: lobby.modId,
				type: lobby.type,
				hostId: null,
				hostName: null,
				playerCount: lobby.size,
				maxPlayers: lobby.max,
				createdAt: null,
				isReported: false,
			}))
		const legacy = all.map((lobby) => ({
			source: 'legacy' as const,
			code: lobby.code,
			modId: lobby.modId,
			type: lobby.type,
			hostId: lobby.hostId,
			hostName: lobby.players.get(lobby.hostId)?.getDisplayName() ?? null,
			playerCount: lobby.playerCount,
			maxPlayers: lobby.maxPlayers,
			createdAt: lobby.createdAt.toISOString(),
			isReported: lobby.isReported,
		}))
		const merged = [...nakama, ...legacy]

		const total = merged.length
		const offset = (page - 1) * limit
		const pageItems = merged.slice(offset, offset + limit)

		res.json({ lobbies: pageItems, total, page, limit })
	} catch (err) {
		next(err)
	}
})

router.get('/lobbies/:code', async (req, res, next) => {
	try {
		const nakama = await getNakamaLobby(req.params.code)
		if (nakama) {
			res.json({
				lobby: {
					source: 'nakama',
					code: nakama.code,
					modId: nakama.modId,
					type: null,
					hostId: nakama.hostId,
					maxPlayers: nakama.maxPlayers,
					playerCount: nakama.players.length,
					metadata: nakama.metadata,
					createdAt: new Date(nakama.createdAt).toISOString(),
					isReported: false,
					started: nakama.started,
				},
				players: nakama.players,
			})
			return
		}

		const lobby = getLobby(req.params.code)
		if (!lobby) throw new AppError('Lobby not found', 404)

		const { lobbyService } = await import('../../routes/index.js')
		const players = lobbyService.getLobbyPlayers(lobby.code)

		res.json({
			lobby: {
				code: lobby.code,
				modId: lobby.modId,
				type: lobby.type,
				hostId: lobby.hostId,
				maxPlayers: lobby.maxPlayers,
				playerCount: lobby.playerCount,
				metadata: lobby.metadata,
				createdAt: lobby.createdAt.toISOString(),
				isReported: lobby.isReported,
			},
			players,
		})
	} catch (err) {
		next(err)
	}
})

router.post('/lobbies/:code/kick/:playerId', async (req, res, next) => {
	try {
		const reason = `admin:${req.player!.playerId}`
		if (!(await kickFromNakamaLobby(req.params.code, req.params.playerId, reason))) {
			const { lobbyService } = await import('../../routes/index.js')
			await lobbyService.adminKickPlayer(
			req.params.code,
				req.params.playerId,
				req.player!.playerId,
			)
		}

		console.log(
			`[webadmin] ${req.player!.playerId} kicked ${req.params.playerId} from lobby ${req.params.code}`,
		)
		res.json({ ok: true })
	} catch (err) {
		next(err)
	}
})

router.post('/lobbies/:code/close', async (req, res, next) => {
	try {
		if (!(await closeNakamaLobby(req.params.code))) {
			const { lobbyService } = await import('../../routes/index.js')
			await lobbyService.adminCloseLobby(req.params.code, req.player!.playerId)
		}

		console.log(
			`[webadmin] ${req.player!.playerId} closed lobby ${req.params.code}`,
		)
		res.json({ ok: true })
	} catch (err) {
		next(err)
	}
})

export default router
