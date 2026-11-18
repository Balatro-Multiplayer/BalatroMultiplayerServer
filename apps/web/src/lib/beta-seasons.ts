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
