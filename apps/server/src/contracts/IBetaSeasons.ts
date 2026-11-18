// What the Beta Seasons routes read (features/beta-seasons/). Beta Seasons are
// the ranked seasons of the Discord queue era; their players are known by the
// salted Discord id hash and link to an account with the same hash.

export interface BetaSeasonBoard {
	modId: string
	// Stored under the matchmaking key, with the `ranked:` prefix.
	gameMode: string
	entries: number
}

export interface BetaSeason {
	number: number
	name: string
	startedAt: Date | null
	endedAt: Date | null
	boards: BetaSeasonBoard[]
}

export interface BetaBoardQuery {
	season: number
	modId: string
	gameMode: string
	/** A name search over the legacy name and the linked account's names. */
	term: string | null
}

// A player as a Beta Season row shows them: the linked account when there is
// one, else the legacy name with no account.
export interface BetaPlayerRef {
	playerId: string | null
	displayName: string
}

export interface BetaStandingRow extends BetaPlayerRef {
	rank: number
	rating: number
	peakRating: number | null
	wins: number
	losses: number
	gamesPlayed: number
}

export interface BetaPlayerStanding {
	season: number
	seasonName: string
	modId: string
	gameMode: string
	rank: number
	boardSize: number
	rating: number
	peakRating: number | null
	wins: number
	losses: number
	gamesPlayed: number
}

export type BetaGameResult = 'win' | 'loss' | 'tie'

export interface BetaGameRow {
	playedAt: Date
	result: BetaGameResult
	ratingAfter: number | null
	ratingChange: number | null
	deck: string | null
	stake: string | null
	opponent: BetaPlayerRef | null
}

export interface BetaGamesQuery {
	discordIdHash: string
	season: number
	modId: string
	gameMode: string
}

export interface IBetaSeasonsRepository {
	listSeasons(): Promise<BetaSeason[]>
	countBoard(q: BetaBoardQuery): Promise<number>
	boardPage(
		q: BetaBoardQuery,
		pageSize: number,
		offset: number,
	): Promise<BetaStandingRow[]>
	/** The live account's Discord hash, or null when it has none linked. */
	discordHashOf(playerId: string): Promise<string | null>
	standingsOf(discordIdHash: string): Promise<BetaPlayerStanding[]>
	countGames(q: BetaGamesQuery): Promise<number>
	gamesPage(
		q: BetaGamesQuery,
		pageSize: number,
		offset: number,
	): Promise<BetaGameRow[]>
}
