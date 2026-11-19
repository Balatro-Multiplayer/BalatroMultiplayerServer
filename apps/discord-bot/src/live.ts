import { type Ladder, topNeeded } from './ladders.js'
import type { FetchChanges } from './standings-client.js'
import type { GuildMemberInfo, SweepSummary } from './sweep.js'

// Role updates right after matches, between the full sweeps. Each tick asks
// the API who played since the last tick and who holds the top places now.
// One match can move other players across a leaderboard boundary (a new #3
// pushes the old #3 down to Holographic), so whenever anything moved, the
// tick re-checks:
// - linked members who played,
// - members now in the top places,
// - members who hold a leaderboard role (they may have dropped out),
// - members whose role change failed on an earlier tick (3 tries in all).
// Members who linked since the last sweep aren't known yet; the sweep picks
// them up.

/** Tries in all (the first one included) for a member whose role change
 * keeps failing; after that the next sweep tries again. */
export const MAX_TRIES = 3

export interface LiveOptions {
	fetchChanges: FetchChanges
	ladders: Ladder[]
	/** Discord id -> player id, filled by the sweeps. */
	links: Map<string, string>
	/** Discord ids of every leaderboard role. */
	leaderboardRoleIds: ReadonlySet<string>
	cachedMembers(): GuildMemberInfo[]
	/** Re-check these members (sweep.ts syncSome). */
	sync(memberIds: string[]): Promise<SweepSummary>
}

/** Returns a tick: null when nothing moved, else the re-check's summary. */
export function createLiveUpdater(
	opts: LiveOptions,
): () => Promise<SweepSummary | null> {
	const cursors = new Map<Ladder, string>()
	const tops = new Map<Ladder, string>()
	// The last answer's rows (player id -> updated_at). The cursor's overlap
	// returns a row on several ticks; it counts as moved only the first time.
	let seen = new Map<Ladder, Map<string, string>>()
	// Discord id -> failed tries so far.
	const failed = new Map<string, number>()

	return async function tick() {
		const discordOf = new Map<string, string>()
		for (const [discordId, playerId] of opts.links)
			discordOf.set(playerId, discordId)

		const ids = new Set<string>(failed.keys())
		let moved = failed.size > 0
		const nextCursors = new Map<Ladder, string>()
		const nextTops = new Map<Ladder, string>()
		const nextSeen = new Map<Ladder, Map<string, string>>()
		for (const ladder of opts.ladders) {
			const answer = await opts.fetchChanges({
				modId: ladder.modId,
				gameMode: ladder.gameMode,
				topN: topNeeded(ladder),
				since: cursors.get(ladder) ?? null,
			})
			nextCursors.set(ladder, answer.cursor)
			const top = answer.top.join(',')
			nextTops.set(ladder, top)
			// The first tick only sets the starting point.
			if (tops.has(ladder) && tops.get(ladder) !== top) moved = true
			const before = seen.get(ladder)
			const rows = new Map<string, string>()
			for (const { playerId, updatedAt } of answer.changed) {
				rows.set(playerId, updatedAt)
				if (before?.get(playerId) === updatedAt) continue
				const discordId = discordOf.get(playerId)
				if (discordId) {
					ids.add(discordId)
					moved = true
				}
			}
			nextSeen.set(ladder, rows)
			for (const playerId of answer.top) {
				const discordId = discordOf.get(playerId)
				if (discordId) ids.add(discordId)
			}
		}

		let summary: SweepSummary | null = null
		if (moved) {
			for (const m of opts.cachedMembers())
				if (m.roleIds.some((r) => opts.leaderboardRoleIds.has(r))) ids.add(m.id)
			summary = await opts.sync([...ids])
			const failedNow = new Set(summary.failedMemberIds)
			for (const id of ids) {
				const tries = (failed.get(id) ?? 0) + 1
				if (failedNow.has(id) && tries < MAX_TRIES) failed.set(id, tries)
				else failed.delete(id)
			}
		}
		// Only once the re-check ran without throwing (its standings read
		// worked), so a tick whose read failed is redone from the same cursor.
		// Members whose role change failed are retried through `failed`.
		for (const [ladder, cursor] of nextCursors) cursors.set(ladder, cursor)
		for (const [ladder, top] of nextTops) tops.set(ladder, top)
		seen = nextSeen
		return summary
	}
}
