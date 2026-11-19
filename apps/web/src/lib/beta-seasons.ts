// Beta Seasons: the ranked seasons of the Discord queue era, read-only.
// A player shows as their account (playerId set) when that account has the
// same Discord account linked; else by the name they had then (playerId null).

export interface BetaBoard {
  modId: string
  gameMode: string
  entries: number
}

export interface BetaSeason {
  number: number
  name: string
  startedAt: string | null
  endedAt: string | null
  boards: BetaBoard[]
}

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

export interface BetaBoardResponse {
  season: number
  page: number
  pageSize: number
  total: number
  totalPages: number
  entries: BetaStandingRow[]
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

export interface BetaGameRow {
  playedAt: string
  result: 'win' | 'loss' | 'tie'
  ratingAfter: number | null
  ratingChange: number | null
  deck: string | null
  stake: string | null
  opponent: BetaPlayerRef | null
  /** The game's legacy match log, when the viewer may open it. */
  logId: number | null
}

export interface BetaGamesResponse {
  page: number
  pageSize: number
  total: number
  totalPages: number
  games: BetaGameRow[]
}

export const BETA_SEASONS_PATH = '/stats/beta-seasons'

/** The boards one Beta Season has for a mod, biggest first. */
export function betaBoardsOf(
  season: BetaSeason | undefined,
  modId: string
): BetaBoard[] {
  return (season?.boards ?? [])
    .filter((b) => b.modId === modId)
    .sort((a, b) => b.entries - a.entries)
}

// Each Beta Season's rating system, fitted from its games: every season used
// Elo, with its own start rating and scale (the rating gap that makes a 10:1
// favourite). Season 1 has no games saved, so its scale is an estimate from
// the spread of its standings.
const BETA_ELO: Record<number, { start: number; scale: number }> = {
  1: { start: 1000, scale: 1000 },
  2: { start: 200, scale: 700 },
  3: { start: 200, scale: 700 },
  4: { start: 200, scale: 1200 },
  5: { start: 200, scale: 1200 },
  6: { start: 200, scale: 1200 },
  7: { start: 500, scale: 1200 },
}

// The current system: new players start at 600, the scale is 1000, and no
// rating goes below 100.
const NOW_START = 600
const NOW_SCALE = 1000
const NOW_FLOOR = 100

/**
 * A Beta Season rating on the current scale: the same distance from the
 * start rating, in the same win odds. Placement games are not modelled.
 */
export function ratingNow(season: number, rating: number): number {
  const elo = BETA_ELO[season]
  if (!elo) return Math.round(rating)
  const mapped = NOW_START + ((rating - elo.start) * NOW_SCALE) / elo.scale
  return Math.max(NOW_FLOOR, Math.round(mapped))
}

/** A Beta Season rating change on the current scale. */
export function ratingChangeNow(season: number, change: number): number {
  const elo = BETA_ELO[season]
  return Math.round(elo ? (change * NOW_SCALE) / elo.scale : change)
}
