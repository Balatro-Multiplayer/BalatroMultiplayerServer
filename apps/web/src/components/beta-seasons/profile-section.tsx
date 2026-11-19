'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { type ReactNode, useState } from 'react'
import { legacyMatchPath } from '@/app/(home)/matches/lib/match-view'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import {
  BETA_SEASONS_PATH,
  type BetaGamesResponse,
  type BetaPlayerStanding,
} from '@/lib/beta-seasons'
import { LEADERBOARD_CATEGORIES } from '@/lib/leaderboards'
import { BetaPlayerName, BetaRating, BetaRatingChange } from './board-table'

interface BetaPlayerResponse {
  linked: boolean
  standings: BetaPlayerStanding[]
}

function modeLabel(modId: string, gameMode: string): string {
  const id = gameMode.replace(/^ranked:/, '')
  return (
    LEADERBOARD_CATEGORIES.find((c) => c.modId === modId)?.modes.find(
      (m) => m.id === id
    )?.label ?? id
  )
}

const keyOf = (s: BetaPlayerStanding) => `${s.season}|${s.modId}|${s.gameMode}`

/**
 * The player's Beta Season standings and games. Shown only when their account
 * has the Discord account linked that played those seasons.
 */
export function BetaSeasonsSection({ playerId }: { playerId: string }) {
  const { data } = useQuery<BetaPlayerResponse>({
    queryKey: ['beta-player', playerId],
    queryFn: () => apiFetch(`${BETA_SEASONS_PATH}/players/${playerId}`),
    enabled: !!playerId,
    staleTime: 10 * 60 * 1000,
  })
  const standings = data?.standings ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const selected = standings.find((s) => keyOf(s) === picked) ?? standings[0]
  if (!selected) return null

  return (
    <div className='space-y-3'>
      <div>
        <h2 className='font-bold text-lg tracking-tight'>Beta Seasons</h2>
        <p className='text-muted-foreground text-xs'>
          Ranked seasons from the Discord queue era. Pick a board to see its
          games.
        </p>
      </div>
      <div className='grid grid-cols-1 gap-4 font-readable sm:grid-cols-2 lg:grid-cols-4'>
        {standings.map((s) => {
          const active = keyOf(s) === keyOf(selected)
          return (
            <button
              key={keyOf(s)}
              type='button'
              onClick={() => setPicked(keyOf(s))}
              className='text-left'
            >
              <Card
                className={`h-full transition-colors ${active ? 'border-primary' : 'hover:border-muted-foreground/50'}`}
              >
                <CardHeader className='pb-2'>
                  <CardTitle className='text-sm'>
                    {s.seasonName} · {modeLabel(s.modId, s.gameMode)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className='space-y-2 text-sm'>
                    <Stat label='Rank' value={`#${s.rank} of ${s.boardSize}`} />
                    <Stat
                      label='Rating'
                      value={<BetaRating season={s.season} rating={s.rating} />}
                    />
                    {s.peakRating != null && (
                      <Stat
                        label='Peak'
                        value={
                          <BetaRating season={s.season} rating={s.peakRating} />
                        }
                      />
                    )}
                    <Stat label='W / L' value={`${s.wins} / ${s.losses}`} />
                    <Stat label='Games' value={String(s.gamesPlayed)} />
                  </dl>
                </CardContent>
              </Card>
            </button>
          )
        })}
      </div>
      <BetaGames
        key={keyOf(selected)}
        playerId={playerId}
        standing={selected}
      />
    </div>
  )
}

function BetaGames({
  playerId,
  standing,
}: {
  playerId: string
  standing: BetaPlayerStanding
}) {
  const [page, setPage] = useState(1)
  const { data, isLoading } = useQuery<BetaGamesResponse>({
    queryKey: ['beta-games', playerId, keyOf(standing), page],
    queryFn: () =>
      apiFetch(
        `${BETA_SEASONS_PATH}/players/${playerId}/games?season=${standing.season}&modId=${encodeURIComponent(standing.modId)}&gameMode=${encodeURIComponent(standing.gameMode)}&page=${page}`
      ),
    placeholderData: (prev) => prev,
  })
  const games = data?.games ?? []
  const totalPages = data?.totalPages ?? 1

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>
          {standing.seasonName} · {modeLabel(standing.modId, standing.gameMode)}{' '}
          · Games
        </CardTitle>
      </CardHeader>
      <CardContent className='p-0'>
        {isLoading ? (
          <p className='p-6 text-muted-foreground text-sm'>Loading…</p>
        ) : games.length === 0 ? (
          <p className='p-6 text-muted-foreground text-sm'>
            No games saved for this board.
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full font-readable text-sm'>
              <thead>
                <tr className='border-border border-b bg-muted/40'>
                  {[
                    'Date',
                    'Result',
                    'Opponent',
                    'Change',
                    'Rating',
                    'Deck',
                    'Stake',
                    'Log',
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
                {games.map((g, i) => (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows of one page, read-only
                    key={i}
                    className='transition-colors hover:bg-muted/30'
                  >
                    <td className='whitespace-nowrap px-4 py-2 text-muted-foreground'>
                      {new Date(g.playedAt).toLocaleString()}
                    </td>
                    <td
                      className={`px-4 py-2 font-semibold ${RESULT_CLASS[g.result]}`}
                    >
                      {RESULT_LABEL[g.result]}
                    </td>
                    <td className='px-4 py-2'>
                      {g.opponent ? (
                        <BetaPlayerName player={g.opponent} />
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className='px-4 py-2'>
                      <BetaRatingChange
                        season={standing.season}
                        change={g.ratingChange}
                      />
                    </td>
                    <td className='px-4 py-2 font-pixel text-bal-gold'>
                      <BetaRating
                        season={standing.season}
                        rating={g.ratingAfter}
                      />
                    </td>
                    <td className='px-4 py-2 text-muted-foreground'>
                      {g.deck ?? '-'}
                    </td>
                    <td className='px-4 py-2 text-muted-foreground'>
                      {g.stake ?? '-'}
                    </td>
                    <td className='px-4 py-2'>
                      {g.logId == null ? (
                        '-'
                      ) : (
                        <Link
                          href={legacyMatchPath(g.logId)}
                          className='text-bal-blue hover:underline'
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className='flex items-center justify-between border-border border-t px-4 py-3'>
            <span className='text-muted-foreground text-xs'>
              {data?.total} games
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
                Page {page} of {totalPages}
              </span>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const RESULT_LABEL = { win: 'Win', loss: 'Loss', tie: 'Tie' } as const
const RESULT_CLASS = {
  win: 'text-bal-green',
  loss: 'text-bal-red',
  tie: 'text-muted-foreground',
} as const

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='flex justify-between'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='font-semibold'>{value}</dd>
    </div>
  )
}
