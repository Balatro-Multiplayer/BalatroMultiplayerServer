import type {
	DiscordBotMember,
	DiscordBotRating,
	DiscordBotStandingsAnswer,
	DiscordBotStandingsRequest,
} from '@bmp/types'
import type { BoardReads } from '../../infrastructure/gateways/discord-standings.gateway.js'

// What the Discord rank-role bot (apps/discord-bot) needs to pick a member's
// roles. The bot sends raw Discord ids; they are hashed here with the same
// salt as at link time, so the bot never holds the salt or a database login.
// The request and answer shapes live in @bmp/types (discord-bot.ts), shared
// with the bot.

export interface StandingsDeps {
	hashDiscordId(discordId: string): string
	currentSeasonId(): Promise<number | null>
	previousSeasonId(seasonId: number): Promise<number | null>
	playerIdsByDiscordIdHash(hashes: string[]): Promise<Map<string, string>>
	/**
	 * Runs board reads in one snapshot, so the ratings and the top list agree
	 * even while a match or a void commits. A void rebuilds a board in one
	 * transaction (void-match.ts), so a snapshot never holds half of one.
	 */
	inBoardSnapshot<T>(read: (reads: BoardReads) => Promise<T>): Promise<T>
}

export class NoActiveSeasonError extends Error {}

export function createStandingsService(deps: StandingsDeps) {
	return {
		async standings(
			req: DiscordBotStandingsRequest,
		): Promise<DiscordBotStandingsAnswer> {
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
			const { current, previous, top } = await deps.inBoardSnapshot(
				async (reads) => ({
					current: await reads.boardRatings(board, playerIds),
					previous:
						previousSeason === null
							? new Map<string, DiscordBotRating>()
							: await reads.boardRatings(
									{ ...board, seasonId: previousSeason },
									playerIds,
								),
					top: req.topN > 0 ? await reads.topPlayerIds(board, req.topN) : [],
				}),
			)

			const players: Record<string, DiscordBotMember> = {}
			for (const [discordId, playerId] of playerOf)
				players[discordId] = {
					playerId,
					current: current.get(playerId) ?? null,
					previous: previous.get(playerId) ?? null,
				}
			return { season, previousSeason, players, top }
		},
	}
}

export type StandingsService = ReturnType<typeof createStandingsService>
