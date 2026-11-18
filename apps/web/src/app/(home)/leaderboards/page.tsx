'use client'

import { useQuery } from '@tanstack/react-query'
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs'
import { Suspense, useEffect, useState } from 'react'
import { BetaBoardTable } from '@/components/beta-seasons/board-table'
import { RankBadge } from '@/components/rank-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import {
  BETA_SEASONS_PATH,
  type BetaBoardResponse,
  type BetaSeason,
  betaBoardsOf,
} from '@/lib/beta-seasons'
import {
  type BoardCounts,
  pickCategory,
  pickMode,
  sortCategoriesByEntries,
  sortModesByEntries,
} from '@/lib/leaderboard-order'
import {
  formatMetric,
  gameModeKey,
  LEADERBOARD_CATEGORIES,
  seasonLabel,
} from '@/lib/leaderboards'

interface Season {
  id: number
  name: string
  startedAt: string
  endsAt: string | null
  endedAt: string | null
}

interface LeaderboardEntry {
  rank: number
  playerId: string
  displayName: string
  rating: number
  wins: number
  losses: number
  gamesPlayed: number
  seasonBest: number | string | null
}

interface BoardCountsResponse {
  season: number | null
  counts: BoardCounts
}

interface SeasonsResponse {
  seasons: Season[]
  current: number | null
}

interface LeaderboardResponse {
  season: number
  modId: string
  gameMode: string
  page: number
  pageSize: number
  total: number
  totalPages: number
  entries: LeaderboardEntry[]
}

export default function LeaderboardsPage() {
  // useQueryState() reads search params; wrap in Suspense so static prerender
  // doesn't bail out of CSR.
  return (
    <Suspense
      fallback={
        <div className='container py-8 text-muted-foreground'>Loading…</div>
      }
    >
      <LeaderboardsContent />
    </Suspense>
  )
}

function LeaderboardsContent() {
  const [search, setSearch] = useState('')
  const [categoryParam, setCategoryParam] = useQueryState(
    'category',
    parseAsString
  )
  const [modeParam, setModeParam] = useQueryState('mode', parseAsString)
  const [seasonParam, setSeasonParam] = useQueryState('season', parseAsInteger)
  // A Beta Season is picked apart from the live seasons: its own param.
  const [betaParam, setBetaParam] = useQueryState('beta', parseAsInteger)
  const [page, setPage] = useState(1)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce the search box, and reset to page 1 when the term changes — the
  // server searches the whole list, so a match can live on any page.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  // Mods and game modes are ordered by their entries in the current season.
  // With no choice in the URL the page opens on the biggest of each.
  const { data: countsData, isLoading: countsLoading } =
    useQuery<BoardCountsResponse>({
      queryKey: ['leaderboard-counts'],
      queryFn: () => apiFetch('/stats/leaderboard-counts'),
      staleTime: 10 * 60 * 1000,
    })
  const counts = countsData?.counts ?? {}
  const categories = sortCategoriesByEntries(LEADERBOARD_CATEGORIES, counts)
  const category = pickCategory(categories, categoryParam)

  const { data: betaData } = useQuery<{ seasons: BetaSeason[] }>({
    queryKey: ['beta-seasons'],
    queryFn: () => apiFetch(BETA_SEASONS_PATH),
    staleTime: 60 * 60 * 1000,
  })
  const betaSeasons = (betaData?.seasons ?? []).filter(
    (s) => betaBoardsOf(s, category.modId).length > 0
  )
  const betaSeason =
    betaParam != null
      ? betaSeasons.find((s) => s.number === betaParam)
      : undefined

  // A Beta Season shows only the boards it had, biggest first.
  const modes = betaSeason
    ? betaBoardsOf(betaSeason, category.modId).flatMap((b) =>
        category.modes.filter((m) => gameModeKey(m.id) === b.gameMode)
      )
    : sortModesByEntries(category, counts)
  const mode = pickMode(modes, modeParam)

  const { data: seasonsData } = useQuery<SeasonsResponse>({
    queryKey: ['seasons'],
    queryFn: () => apiFetch('/stats/seasons'),
  })

  const seasons = seasonsData?.seasons ?? []
  const currentSeasonId = seasonsData?.current ?? seasons.at(-1)?.id ?? null
  const selectedSeason = seasonParam ?? currentSeasonId

  const { data: leaderboardData, isLoading: lbLoading } =
    useQuery<LeaderboardResponse>({
      queryKey: [
        'leaderboard',
        category.modId,
        mode.id,
        selectedSeason,
        page,
        debouncedSearch,
      ],
      queryFn: () =>
        apiFetch(
          `/stats/leaderboard?modId=${encodeURIComponent(category.modId)}&gameMode=${encodeURIComponent(gameModeKey(mode.id))}${selectedSeason != null ? `&season=${selectedSeason}` : ''}&page=${page}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}`
        ),
      enabled:
        !betaSeason &&
        selectedSeason != null &&
        (!countsLoading || (categoryParam != null && modeParam != null)),
      placeholderData: (prev) => prev,
    })

  const { data: betaBoardData, isLoading: betaLoading } =
    useQuery<BetaBoardResponse>({
      queryKey: [
        'beta-board',
        betaSeason?.number,
        category.modId,
        mode.id,
        page,
        debouncedSearch,
      ],
      queryFn: () =>
        apiFetch(
          `${BETA_SEASONS_PATH}/${betaSeason?.number}/leaderboard?modId=${encodeURIComponent(category.modId)}&gameMode=${encodeURIComponent(gameModeKey(mode.id))}&page=${page}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}`
        ),
      enabled: !!betaSeason,
      placeholderData: (prev) => prev,
    })

  const entries = leaderboardData?.entries ?? []
  const board = betaSeason ? betaBoardData : leaderboardData
  const boardLoading = betaSeason ? betaLoading : lbLoading

  return (
    <div className='container space-y-6 py-8'>
      <div className='space-y-1'>
        <h1 className='font-bold text-3xl tracking-tight'>Leaderboards</h1>
        <p className='text-muted-foreground'>
          Ranked standings by game and mode, per season.
        </p>
      </div>

      {/* Mod selector, biggest board first */}
      <div className='flex flex-wrap gap-2'>
        {categories.map((c) => (
          <button
            key={c.id}
            type='button'
            onClick={() => {
              setCategoryParam(c.id)
              setModeParam(null)
              setBetaParam(null)
              setPage(1)
            }}
            className={`rounded-md border px-4 py-2 font-bold font-pixel text-base transition-colors ${
              category.id === c.id
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-muted text-muted-foreground hover:bg-accent'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Game mode tabs, biggest board first */}
      <div className='flex flex-wrap gap-1 border-border border-b'>
        {modes.map((m) => (
          <button
            key={m.id}
            type='button'
            onClick={() => {
              setModeParam(m.id)
              setPage(1)
            }}
            className={`-mb-px border-b-2 px-4 py-2 font-medium text-sm transition-colors ${
              mode.id === m.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Season pills */}
      {seasons.length > 0 && (
        <div className='flex flex-wrap gap-2'>
          {seasons.map((s) => (
            <button
              key={s.id}
              type='button'
              onClick={() => {
                setSeasonParam(s.id === currentSeasonId ? null : s.id)
                setBetaParam(null)
                setPage(1)
              }}
              className={`rounded-full border px-3 py-1 font-semibold text-xs transition-colors ${
                !betaSeason && selectedSeason === s.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {seasonLabel(seasons, s.id)}
              {s.id === currentSeasonId && (
                <span className='ml-1.5 text-[10px] text-bal-green'>LIVE</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Beta Season pills: the Discord queue era, oldest first */}
      {betaSeasons.length > 0 && (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-semibold text-muted-foreground text-xs uppercase tracking-wide'>
            Beta
          </span>
          {betaSeasons.map((s) => (
            <button
              key={s.number}
              type='button'
              onClick={() => {
                setBetaParam(s.number)
                setSeasonParam(null)
                setPage(1)
              }}
              className={`rounded-full border px-3 py-1 font-semibold text-xs transition-colors ${
                betaSeason?.number === s.number
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Search + table */}
      <div className='space-y-4'>
        <Input
          placeholder='Search players…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='max-w-sm'
        />

        <Card>
          <CardHeader>
            <CardTitle className='text-base'>
              {category.label} · {mode.label} ·{' '}
              {betaSeason
                ? betaSeason.name
                : seasonLabel(seasons, selectedSeason)}
            </CardTitle>
          </CardHeader>
          <CardContent className='p-0'>
            {betaSeason ? (
              <BetaBoardTable
                loading={betaLoading}
                entries={betaBoardData?.entries ?? []}
              />
            ) : boardLoading ? (
              <p className='p-6 text-muted-foreground text-sm'>Loading…</p>
            ) : entries.length === 0 ? (
              <p className='p-6 text-muted-foreground text-sm'>
                No entries found.
              </p>
            ) : (
              <div className='overflow-x-auto'>
                <table className='w-full font-readable text-sm'>
                  <thead>
                    <tr className='border-border border-b bg-muted/40'>
                      {[
                        'Rank',
                        'Player',
                        'Rating',
                        ...(category.metricLabel ? [category.metricLabel] : []),
                        'W',
                        'L',
                        'Games',
                      ].map((h) => (
                        <th
                          key={h}
                          className='px-4 py-3 text-left font-semibold text-muted-foreground text-xs uppercase tracking-wide'
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-border'>
                    {entries.map((entry) => (
                      <tr
                        key={entry.playerId}
                        className='transition-colors hover:bg-muted/30'
                      >
                        <td className='px-4 py-3'>
                          <RankBadge rank={entry.rank} />
                        </td>
                        <td className='px-4 py-3 font-semibold'>
                          <a
                            href={`/players/${entry.playerId}`}
                            className='transition-colors hover:text-primary'
                          >
                            {entry.displayName}
                          </a>
                        </td>
                        <td className='px-4 py-3 font-bold font-pixel text-bal-gold'>
                          {Math.round(entry.rating)}
                        </td>
                        {category.metricLabel && (
                          <td className='px-4 py-3 font-semibold text-bal-blue'>
                            {formatMetric(category.metric, entry.seasonBest)}
                          </td>
                        )}
                        <td className='px-4 py-3 text-bal-green'>
                          {entry.wins}
                        </td>
                        <td className='px-4 py-3 text-bal-red'>
                          {entry.losses}
                        </td>
                        <td className='px-4 py-3 text-muted-foreground'>
                          {entry.gamesPlayed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {(board?.totalPages ?? 1) > 1 && (
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-xs'>
              {board ? `${board.total} ranked players` : ''}
            </span>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Previous
              </Button>
              <span className='text-muted-foreground text-sm'>
                Page {page} of {board?.totalPages ?? 1}
              </span>
              <Button
                variant='outline'
                size='sm'
                onClick={() =>
                  setPage((p) => Math.min(board?.totalPages ?? 1, p + 1))
                }
                disabled={page >= (board?.totalPages ?? 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
