import type {
	BoardRating,
	BoardSeason,
} from '../../infrastructure/gateways/discord-standings.gateway.js'

// What the Discord rank-role bot (apps/discord-bot) needs to pick a member's
// roles. The bot sends raw Discord ids; they are hashed here with the same
// salt as at link time, so the bot never holds the salt or a database login.

export interface CurrentStanding extends BoardRating {
	/** Place on the public leaderboard, when within the top `topN`; else null. */
	rank: number | null
}

export interface MemberStanding {
	/** The player linked to this Discord account. */
	playerId: string
	/** This season's row on the board; null = no games yet. */
	current: CurrentStanding | null
	/** Last season's final row on the same board; null = no games then. */
	previous: BoardRating | null
}

export interface StandingsAnswer {
	season: number
	previousSeason: number | null
	/** Keyed by Discord id. A missing id has no linked player. */
	players: Record<string, MemberStanding>
	/**
	 * The first `topN` places, in order (empty for topN 0). A bot that reads
	 * its members over several requests ranks them all from one request's
	 * list, so a match between two requests can't give two members #1.
	 */
	top: { playerId: string; rank: number }[]
}

export interface StandingsRequest {
	modId: string
	gameMode: string
	topN: number
	discordIds: string[]
}

export interface StandingsDeps {
	hashDiscordId(discordId: string): string
	currentSeasonId(): Promise<number | null>
	previousSeasonId(seasonId: number): Promise<number | null>
	playerIdsByDiscordIdHash(hashes: string[]): Promise<Map<string, string>>
	boardRatings(
		board: BoardSeason,
		playerIds: string[],
	): Promise<Map<string, BoardRating>>
	/** The first `n` places of the public leaderboard, in order. */
	topOfBoard(
		board: BoardSeason,
		n: number,
	): Promise<{ playerId: string; rank: number }[]>
	/**
	 * Runs board reads while no rebuild (a void) can start; throws
	 * BoardRebuildingError if one is running. See board-lock.ts.
	 */
	readingStableBoard<T>(
		board: { modId: string; gameMode: string },
		read: () => Promise<T>,
	): Promise<T>
}

export class NoActiveSeasonError extends Error {}

export function createStandingsService(deps: StandingsDeps) {
	return {
		async standings(req: StandingsRequest): Promise<StandingsAnswer> {
			const season = await deps.currentSeasonId()
			if (season === null) throw new NoActiveSeasonError('No active season')
			const previousSeason = await deps.previousSeasonId(season)

			const hashOf = new Map(
				req.discordIds.map((id) => [id, deps.hashDiscordId(id)]),
			)
			const playerByHash = await deps.playerIdsByDiscordIdHash([
				...new Set(hashOf.values()),
			])
			const playerOf = new Map<string, string>()
			for (const [discordId, hash] of hashOf) {
				const playerId = playerByHash.get(hash)
				if (playerId) playerOf.set(discordId, playerId)
			}
			const playerIds = [...new Set(playerOf.values())]

			const board = {
				modId: req.modId,
				gameMode: req.gameMode,
				seasonId: season,
			}
			const [current, previous, top] = await deps.readingStableBoard(
				board,
				() =>
					Promise.all([
						deps.boardRatings(board, playerIds),
						previousSeason === null
							? Promise.resolve(new Map<string, BoardRating>())
							: deps.boardRatings(
									{ ...board, seasonId: previousSeason },
									playerIds,
								),
						req.topN > 0
							? deps.topOfBoard(board, req.topN)
							: Promise.resolve([]),
					]),
			)
			const rankOf = new Map(top.map((t) => [t.playerId, t.rank]))

			const players: Record<string, MemberStanding> = {}
			for (const [discordId, playerId] of playerOf) {
				const now = current.get(playerId)
				players[discordId] = {
					playerId,
					current: now ? { ...now, rank: rankOf.get(playerId) ?? null } : null,
					previous: previous.get(playerId) ?? null,
				}
			}
			return { season, previousSeason, players, top }
		},
	}
}

export type StandingsService = ReturnType<typeof createStandingsService>
