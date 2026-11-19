'use client'

import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmCard } from '@/components/admin/confirm-card'
import {
  RatingChangesTable,
  type RatingSnapshot,
} from '@/components/admin/rating-changes-table'
import { Button } from '@/components/ui/button'
import { ApiError, apiFetch, apiFetchWithReason } from '@/lib/api'

interface ReplayResponse {
  season: { id: number; name: string }
  games: number
  changedPlayers: number
  activeRankedGames: number
  retentionRisk: boolean
  token: string
  players: {
    userId: string
    name: string
    modId: string
    mode: string
    before: RatingSnapshot | null
    after: RatingSnapshot
  }[]
}

interface ApplyResponse {
  backupId: string
  games: number
  players: number
  repairedGames: number
  dismissedItems: number
  itemsLeftOpen: number
}

function toastError(e: Error) {
  toast.error(e instanceof ApiError ? e.message : e.message || 'Request failed')
}

export function SeasonReplayPanel() {
  const replayMut = useMutation<ReplayResponse, Error>({
    mutationFn: () =>
      apiFetch('/webadmin/ratings/season-replay', { method: 'POST' }),
    onError: toastError,
  })
  const result = replayMut.data
  const [confirming, setConfirming] = useState(false)
  const applyMut = useMutation<
    ApplyResponse,
    Error,
    { token: string; note: string }
  >({
    mutationFn: ({ token, note }) =>
      apiFetchWithReason(
        '/webadmin/ratings/season-replay/apply',
        { method: 'POST', body: JSON.stringify({ token }) },
        note
      ),
    onSettled: () => setConfirming(false),
    onError: toastError,
  })
  const applied = applyMut.data

  return (
    <div className='space-y-3 rounded-xl border border-border bg-card p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h2 className='font-pixel text-lg'>Season replay</h2>
          <p className='text-muted-foreground text-sm'>
            Replays every ranked game of the current Season under the current
            rules and shows each player&apos;s rating before and after. Games
            with an anti-cheat flag are rated too, and the Season best is
            rebuilt from the same games. The dry run writes nothing.
          </p>
        </div>
        <Button
          onClick={() => {
            applyMut.reset()
            replayMut.mutate()
          }}
          disabled={replayMut.isPending}
        >
          {replayMut.isPending ? 'Replaying…' : 'Run dry run'}
        </Button>
      </div>

      {result && (
        <>
          <p className='text-sm'>
            {result.season.name}: {result.games} games replayed,{' '}
            {result.changedPlayers} players change. {result.activeRankedGames}{' '}
            ranked games are running now.
          </p>
          {result.activeRankedGames > 0 && (
            <p className='font-medium text-destructive text-sm'>
              Apply is refused while a ranked game is running.
            </p>
          )}
          {result.retentionRisk && (
            <p className='font-medium text-destructive text-sm'>
              This Season started before the run retention window (180 days).
              Some of its runs may be purged, so the replay would miss them.
              Apply is refused.
            </p>
          )}
          {applied ? (
            <p className='font-medium text-sm'>
              Applied: {applied.games} games, {applied.players} players,{' '}
              {applied.repairedGames} games now rated, {applied.dismissedItems}{' '}
              queue items dismissed
              {applied.itemsLeftOpen > 0 &&
                ` (${applied.itemsLeftOpen} left open)`}
              . Backup {applied.backupId}.
            </p>
          ) : (
            <Button variant='destructive' onClick={() => setConfirming(true)}>
              Apply this replay…
            </Button>
          )}
          <RatingChangesTable
            rows={result.players.map((p) => ({
              key: `${p.modId}:${p.mode}:${p.userId}`,
              name: p.name || p.userId,
              href: null,
              board: `${p.modId} ${p.mode}`,
              before: p.before,
              after: p.after,
            }))}
          />
        </>
      )}
      {confirming && result && (
        <ConfirmCard
          title='Apply the season replay?'
          rows={[
            {
              label: 'Season board',
              value: `Replaced with the numbers above (${result.games} games, ${result.changedPlayers} players change)`,
            },
            { label: 'Backup', value: 'Saved first' },
            {
              label: 'Queue items',
              value:
                'The anti-cheat flag items of the repaired games are dismissed',
            },
            {
              label: 'Refused if',
              value:
                'A ranked game is running, or the replay changed since this dry run',
            },
            { label: 'Players', value: 'No player is messaged' },
          ]}
          placeholder='Why apply this replay?'
          confirmLabel='Apply replay'
          pending={applyMut.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={(note) => applyMut.mutate({ token: result.token, note })}
        />
      )}
    </div>
  )
}
