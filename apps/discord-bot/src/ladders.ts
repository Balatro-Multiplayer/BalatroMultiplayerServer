// The rank ladders the bot keeps in sync: which board each one reads, and the
// rules that turn a standing on it into Discord roles. The numbers live here,
// not in the logic (rank-logic.ts). Each role's Discord id comes from the
// environment as DISCORD_ROLE_<ROLE>, e.g. DISCORD_ROLE_GOLD (env.ts).
//
// Another ladder (say Smallworld) is one more entry in LADDERS with its own
// role names; nothing else changes.

export interface RatingRole {
	role: string
	/** Rating at or above which this role applies. */
	min: number
}

export interface LeaderboardRole {
	role: string
	/** Applies to places 1..top on the board. */
	top: number
}

export interface Ladder {
	name: string
	/** The board, as GET /api/stats/leaderboard names it (packages/types/src/board-names.ts). */
	modId: string
	gameMode: string
	/** Games in a season before a rank role is given (the board's placement games). */
	minGames: number
	/** Ascending. A member holds the highest one their rating reaches. */
	ratingRoles: RatingRole[]
	/**
	 * Cutoffs of past seasons, by season id, when they differ from
	 * `ratingRoles`. Read for the last-season fallback (rank-logic.ts). When a
	 * new season moves the cutoffs, copy the old ones here under the ending
	 * season's id first.
	 */
	ratingRolesBySeason: Record<number, RatingRole[]>
	/** A member holds at most one: the smallest `top` their place fits in. */
	leaderboardRoles: LeaderboardRole[]
}

export const EXPANDED: Ladder = {
	name: 'Expanded',
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
	minGames: 5,
	// Fixed for the season. See the README for how these were picked.
	ratingRoles: [
		{ role: 'stone', min: 0 },
		{ role: 'steel', min: 675 },
		{ role: 'gold', min: 750 },
		{ role: 'lucky', min: 900 },
		{ role: 'glass', min: 1050 },
	],
	ratingRolesBySeason: {},
	leaderboardRoles: [
		{ role: 'negative', top: 1 },
		{ role: 'polychrome', top: 3 },
		{ role: 'holographic', top: 10 },
		{ role: 'foil', top: 50 },
	],
}

export const LADDERS: Ladder[] = [EXPANDED]

/** Every role name the ladders use, each once. */
export function managedRoleNames(ladders: Ladder[]): string[] {
	const names = new Set<string>()
	for (const ladder of ladders) {
		for (const r of ladder.ratingRoles) names.add(r.role)
		for (const r of ladder.leaderboardRoles) names.add(r.role)
		for (const set of Object.values(ladder.ratingRolesBySeason))
			for (const r of set) names.add(r.role)
	}
	return [...names]
}

/** How many leaderboard places the ladder needs to know about. */
export function topNeeded(ladder: Ladder): number {
	return Math.max(0, ...ladder.leaderboardRoles.map((r) => r.top))
}
