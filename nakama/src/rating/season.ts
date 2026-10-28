// Rating seasons and inactivity decay, ported from the legacy matchmaking
// gateway. Neither needs a scheduler: a new season's rating is seeded from the
// previous one the first time it is read, and decay is computed from
// lastMatchAt whenever a rating is read (and stored with the player's next game).
import { readConfig } from '../config'
import { DAY_MS } from '../shared/time'
import { applySoftReset, PLACEMENT_GAMES } from './elo'

export const DECAY_INACTIVE_THRESHOLD_DAYS = 7
export const DECAY_RATE_PER_DAY = 5
// Ratings at or below this never decay, and decay stops here.
export const DECAY_FLOOR = 1200

let bootSeason = 1

// The season ratings count toward: the API's active season (its seasons
// table, pushed with the server config), else RATING_SEASON from boot.
export function currentSeason(nk: nkruntime.Nakama): number {
	const pushed = readConfig(nk).season
	return pushed > 0 ? pushed : bootSeason
}

// RATING_SEASON is the runtime env value; anything that isn't a positive
// integer keeps the current fallback.
export function configureSeason(value: string | undefined): void {
	const parsed = value === undefined ? NaN : Number(value)
	if (Number.isInteger(parsed) && parsed > 0) bootSeason = parsed
}

export interface Rated {
	rating: number
	gamesPlayed: number
	lastMatchAt: number
}

// Inactive for more than a week costs 5 points per further whole day, down to
// DECAY_FLOOR. Still-placing players and players who never played don't decay.
export function decayedRating(record: Rated, now: number): number {
	if (record.gamesPlayed < PLACEMENT_GAMES || record.lastMatchAt <= 0) return record.rating
	if (record.rating <= DECAY_FLOOR) return record.rating
	const inactiveDays = (now - record.lastMatchAt) / DAY_MS
	if (inactiveDays <= DECAY_INACTIVE_THRESHOLD_DAYS) return record.rating
	const loss = Math.floor(inactiveDays - DECAY_INACTIVE_THRESHOLD_DAYS) * DECAY_RATE_PER_DAY
	return Math.max(DECAY_FLOOR, record.rating - loss)
}

// A player's first record in a new season: their old rating soft-reset, with
// placement games to play again. Players who never left placement carry nothing.
export function carriedOver(previous: Rated | undefined, now: number): number | undefined {
	if (!previous || previous.gamesPlayed < PLACEMENT_GAMES) return undefined
	return applySoftReset(decayedRating(previous, now))
}
