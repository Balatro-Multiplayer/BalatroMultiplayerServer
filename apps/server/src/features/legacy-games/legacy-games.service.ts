import type {
	ILegacyGamesRepository,
	LegacyGameRow,
	LegacyGameSummary,
} from '../../contracts/ILegacyGames.js'
import type { IModeratorLookup } from '../../contracts/IModeratorLookup.js'
import type {
	ReplayResponse,
	ReplaySide,
	ReplayViewerRole,
} from '../../contracts/IReplayLogRepository.js'
import { decompressFromBase64 } from '../../shared/utils/compression.js'
import { AppError } from '../../shared/utils/errors.js'
import { reduceToResultOnly } from '../replay-log/hidden-side.js'

// Legacy game logs for the website's match view, with the same rules as the
// replay logs (replay-log.service.ts). The uploader ("owner") and moderators
// see the game in full. Anyone else gets a 404 unless the owner shared it;
// then the owner side comes in full and the opponent side, which the opponent
// never shared, is reduced to the result, lives lost and PvP blind scores.

/** Side ids for a side with no live account. */
export const LEGACY_OWNER_ID = 'legacy-owner'
export const LEGACY_OPPONENT_ID = 'legacy-opponent'

export interface LegacyGameInfo {
	id: number
	ownerName: string | null
	opponentName: string | null
	result: LegacyGameRow['result']
	deck: string | null
	stake: string | null
	seed: string | null
	timeExact: boolean
	beta: { season: number; matchKey: string } | null
}

export type LegacyGameResponse = ReplayResponse & { legacy: LegacyGameInfo }

interface LegacyGamesServiceDeps {
	repository: ILegacyGamesRepository
	moderators: IModeratorLookup
}

export type LegacyGamesService = ReturnType<typeof createLegacyGamesService>

function countEvents(block: string): number {
	return (JSON.parse(decompressFromBase64(block)) as unknown[]).length
}

function side(
	playerId: string,
	displayName: string,
	compressedEvents: string,
	shared: boolean,
	hidden: boolean,
): ReplaySide {
	const events = hidden
		? reduceToResultOnly(compressedEvents)
		: compressedEvents
	return {
		playerId,
		displayName,
		shared,
		hidden,
		compressedEvents: events,
		carbonHash: null,
		eventCount: countEvents(events),
		status: 'complete',
		flagReason: null,
	}
}

export function createLegacyGamesService(deps: LegacyGamesServiceDeps) {
	const { repository, moderators } = deps

	async function viewerRole(
		viewerPlayerId: string | null,
		game: LegacyGameRow,
	): Promise<ReplayViewerRole> {
		if (viewerPlayerId === null) return 'public'
		if (await moderators.isModerator(viewerPlayerId)) return 'moderator'
		if (
			game.discordIdHash !== null &&
			(await repository.discordHashOf(viewerPlayerId)) === game.discordIdHash
		) {
			return 'participant'
		}
		return 'public'
	}

	async function getGame(
		id: number,
		viewerPlayerId: string | null,
	): Promise<LegacyGameResponse> {
		const game = await repository.getGame(id)
		if (!game) throw new AppError('Game not found', 404)
		const role = await viewerRole(viewerPlayerId, game)
		const shared = game.sharedAt !== null
		if (role === 'public' && !shared) throw new AppError('Game not found', 404)

		const account = game.discordIdHash
			? await repository.accountOf(game.discordIdHash)
			: null
		const logs = [
			side(
				account?.playerId ?? LEGACY_OWNER_ID,
				account?.displayName ?? game.ownerName ?? 'Unknown player',
				game.ownerEvents,
				shared,
				false,
			),
		]
		if (game.opponentEvents) {
			logs.push(
				side(
					LEGACY_OPPONENT_ID,
					game.opponentName ?? 'Opponent',
					game.opponentEvents,
					false,
					role === 'public',
				),
			)
		}

		return {
			run: {
				id: String(game.id),
				lobbyCode: null,
				modId: 'MultiplayerPvP',
				lobbyType: 'legacy',
				status: 'completed',
				startedAt: game.startedAt,
				finalizedAt: game.endedAt,
			},
			logs,
			viewer:
				viewerPlayerId === null ? { role } : { role, playerId: viewerPlayerId },
			legacy: {
				id: game.id,
				ownerName: game.ownerName,
				opponentName: game.opponentName,
				result: game.result,
				deck: game.deck,
				stake: game.stake,
				seed: game.seed,
				timeExact: game.timeExact,
				beta:
					game.betaSeason !== null && game.betaMatchKey !== null
						? { season: game.betaSeason, matchKey: game.betaMatchKey }
						: null,
			},
		}
	}

	// Share or unshare a game. Only its owner can; 404 for anyone else.
	async function setShared(
		id: number,
		playerId: string,
		shared: boolean,
	): Promise<void> {
		const hash = await repository.discordHashOf(playerId)
		if (!hash || !(await repository.setShared(id, hash, shared))) {
			throw new AppError('Game not found', 404)
		}
	}

	// The caller's own legacy games, newest first.
	async function listMine(
		playerId: string,
		page: number,
		pageSize: number,
	): Promise<{
		games: LegacyGameSummary[]
		total: number
		page: number
		pageSize: number
	}> {
		const hash = await repository.discordHashOf(playerId)
		if (!hash) return { games: [], total: 0, page, pageSize }
		const [total, games] = await Promise.all([
			repository.countForOwner(hash),
			repository.pageForOwner(hash, pageSize, (page - 1) * pageSize),
		])
		return { games, total, page, pageSize }
	}

	return { getGame, setShared, listMine }
}
