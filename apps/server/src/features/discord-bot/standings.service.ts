import type {
	DiscordBotChangesAnswer,
	DiscordBotChangesRequest,
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

/**
 * How far each changes cursor reaches back. A row's updated_at is stamped
 * when its write starts, so a write that commits slowly can carry a time
 * before the last cursor. Rows seen twice are harmless: the bot finds
 * nothing to change.
 */
export const CHANGES_OVERLAP_MS = 2 * 60_000

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
	now(): Date
}

export class NoActiveSeasonError extends Error {}

export function createStandingsService(deps: StandingsDeps) {
	async function currentSeason(): Promise<number> {
		const season = await deps.currentSeasonId()
		if (season === null) throw new NoActiveSeasonError('No active season')
		return season
	}

	return {
		async standings(
			req: DiscordBotStandingsRequest,
		): Promise<DiscordBotStandingsAnswer> {
			const season = await currentSeason()
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

		async changes(
			req: DiscordBotChangesRequest,
		): Promise<DiscordBotChangesAnswer> {
			// Taken before the reads, so a write committing during them is
			// still after the next call's `since`.
			const cursor = new Date(deps.now().getTime() - CHANGES_OVERLAP_MS)
			const season = await currentSeason()
			const board = {
				modId: req.modId,
				gameMode: req.gameMode,
				seasonId: season,
			}
			const since = req.since
			const { changed, top } = await deps.inBoardSnapshot(async (reads) => ({
				changed:
					since === null
						? []
						: await reads.playersChangedSince(board, new Date(since)),
				top: req.topN > 0 ? await reads.topPlayerIds(board, req.topN) : [],
			}))
			return {
				season,
				cursor: cursor.toISOString(),
				changed: changed.map((c) => ({
					playerId: c.playerId,
					updatedAt: c.updatedAt.toISOString(),
				})),
				top,
			}
		},
	}
}

export type StandingsService = ReturnType<typeof createStandingsService>
