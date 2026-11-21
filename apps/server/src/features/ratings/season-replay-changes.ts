import type { RatingRecord, ReplayState } from './season-replay.service.js'

// Each player's rating before and after a Season replay apply, as its staff log
// entry keeps it. Ratings are whole numbers, as the website shows them.

// The staff log detail key that holds the list.
export const RATING_CHANGES_KEY = 'replayRatingChanges'

export interface RatingSnapshot {
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
}

export interface RatingChange {
	userId: string
	// The website account, when the player has one.
	playerId: string | null
	name: string
	modId: string
	mode: string
	before: RatingSnapshot | null
	after: RatingSnapshot
}

const snapshotOf = (record: RatingRecord): RatingSnapshot => ({
	rating: Math.round(record.rating),
	wins: record.wins,
	losses: record.losses,
	gamesPlayed: record.gamesPlayed,
})

export function ratingChangesOf(
	state: ReplayState,
	playerIds: ReadonlyMap<string, string>,
): RatingChange[] {
	const changes: RatingChange[] = []
	for (const board of Object.keys(state).sort()) {
		const split = board.indexOf(':')
		for (const userId of Object.keys(state[board]).sort()) {
			const entry = state[board][userId]
			changes.push({
				userId,
				playerId: playerIds.get(userId) ?? null,
				name: entry.name,
				modId: board.slice(0, split),
				mode: board.slice(split + 1),
				before: entry.before ? snapshotOf(entry.before) : null,
				after: snapshotOf(entry.after),
			})
		}
	}
	return changes
}
