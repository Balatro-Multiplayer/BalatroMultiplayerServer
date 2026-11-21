import type { Ladder, LeaderboardRole, RatingRole } from './ladders.js'

// Pure rules: a member's standing in, the role names they should hold out.
// No Discord, no network. The role combination copies Botlatro
// (src/utils/queueHelpers.ts setUserQueueRole): at most one rating role (the
// highest cutoff reached) plus at most one leaderboard role (the narrowest
// range the place fits in, so #1 holds Negative, not also Polychrome).

export interface Standing {
	gamesPlayed: number
	rating: number
}

export interface CurrentStanding extends Standing {
	/** Place on the public leaderboard when within the top N asked for; else null. */
	rank: number | null
}

/** One linked member's standing, with their place. Undefined = not linked. */
export interface MemberStanding {
	current: CurrentStanding | null
	previous: Standing | null
}

export interface Seasons {
	current: number
	previous: number | null
}

/** The highest role whose cutoff the rating reaches, or null below them all. */
export function ratingRoleFor(
	rating: number,
	roles: RatingRole[],
): string | null {
	let best: RatingRole | null = null
	for (const r of roles)
		if (rating >= r.min && (!best || r.min > best.min)) best = r
	return best?.role ?? null
}

/** The narrowest leaderboard role the place fits in, or null outside them all. */
export function leaderboardRoleFor(
	rank: number | null,
	roles: LeaderboardRole[],
): string | null {
	if (rank === null || rank < 1) return null
	let best: LeaderboardRole | null = null
	for (const r of roles)
		if (rank <= r.top && (!best || r.top < best.top)) best = r
	return best?.role ?? null
}

export function cutoffsFor(ladder: Ladder, seasonId: number): RatingRole[] {
	return ladder.ratingRolesBySeason[seasonId] ?? ladder.ratingRoles
}

/**
 * The role names one ladder gives a member.
 * - Not linked: none.
 * - `minGames`+ games this season: this season's rating role, plus a
 *   leaderboard role if their place earns one.
 * - Fewer games this season: last season's rating role, if they finished
 *   placement then (on that season's cutoffs). Leaderboard roles always
 *   follow the current board.
 * - Neither: none.
 */
export function rolesForLadder(
	ladder: Ladder,
	standing: MemberStanding | undefined,
	seasons: Seasons,
): string[] {
	if (!standing) return []
	const roles: string[] = []
	const { current, previous } = standing
	if (current && current.gamesPlayed >= ladder.minGames) {
		const rating = ratingRoleFor(
			current.rating,
			cutoffsFor(ladder, seasons.current),
		)
		if (rating) roles.push(rating)
		const place = leaderboardRoleFor(current.rank, ladder.leaderboardRoles)
		if (place) roles.push(place)
	} else if (
		previous &&
		seasons.previous !== null &&
		previous.gamesPlayed >= ladder.minGames
	) {
		const rating = ratingRoleFor(
			previous.rating,
			cutoffsFor(ladder, seasons.previous),
		)
		if (rating) roles.push(rating)
	}
	return roles
}

export interface RoleChanges {
	add: string[]
	remove: string[]
}

/**
 * The adds and removes that bring a member from `held` to `wanted`, touching
 * only managed roles. Any role outside `managed` is never added or removed.
 */
export function planRoleChanges(
	held: Iterable<string>,
	wanted: Iterable<string>,
	managed: ReadonlySet<string>,
): RoleChanges {
	const has = new Set(held)
	const want = new Set([...wanted].filter((id) => managed.has(id)))
	return {
		add: [...want].filter((id) => !has.has(id)),
		remove: [...has].filter((id) => managed.has(id) && !want.has(id)),
	}
}
