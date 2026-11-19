import type { BetaPlayerRef } from './IBetaSeasons.js'

// Legacy game logs: games from the legacy website's uploaded logs, in the
// replay event format. The uploader ("owner") is known by the salted Discord
// id hash; the opponent only by the name in the log.

export type LegacyGameResult = 'win' | 'loss'

export interface LegacyGameRow {
	id: number
	discordIdHash: string | null
	ownerName: string | null
	opponentName: string | null
	startedAt: Date
	endedAt: Date | null
	timeExact: boolean
	result: LegacyGameResult | null
	deck: string | null
	stake: string | null
	seed: string | null
	betaSeason: number | null
	betaMatchKey: string | null
	ownerEvents: string
	opponentEvents: string | null
	sharedAt: Date | null
}

/** One game in the owner's list, without the events. */
export type LegacyGameSummary = Omit<
	LegacyGameRow,
	'discordIdHash' | 'ownerEvents' | 'opponentEvents' | 'sharedAt'
> & { shared: boolean }

export interface ILegacyGamesRepository {
	getGame(id: number): Promise<LegacyGameRow | null>
	/** The live account's Discord hash, or null when it has none linked. */
	discordHashOf(playerId: string): Promise<string | null>
	/** The live account that has this Discord hash linked, if any. */
	accountOf(discordIdHash: string): Promise<BetaPlayerRef | null>
	/** False when the game is not the owner's. */
	setShared(
		id: number,
		discordIdHash: string,
		shared: boolean,
	): Promise<boolean>
	countForOwner(discordIdHash: string): Promise<number>
	pageForOwner(
		discordIdHash: string,
		pageSize: number,
		offset: number,
	): Promise<LegacyGameSummary[]>
}
