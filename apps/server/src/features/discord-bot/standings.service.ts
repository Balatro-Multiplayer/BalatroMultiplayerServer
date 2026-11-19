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
			const [current, previous, top] = await Promise.all([
				deps.boardRatings(board, playerIds),
				previousSeason === null
					? Promise.resolve(new Map<string, BoardRating>())
					: deps.boardRatings(
							{ ...board, seasonId: previousSeason },
							playerIds,
						),
				req.topN > 0 ? deps.topOfBoard(board, req.topN) : Promise.resolve([]),
			])
			const rankOf = new Map(top.map((t) => [t.playerId, t.rank]))

			const players: Record<string, MemberStanding> = {}
			for (const [discordId, playerId] of playerOf) {
				const now = current.get(playerId)
				players[discordId] = {
					current: now ? { ...now, rank: rankOf.get(playerId) ?? null } : null,
					previous: previous.get(playerId) ?? null,
				}
			}
			return { season, previousSeason, players }
		},
	}
}

export type StandingsService = ReturnType<typeof createStandingsService>
