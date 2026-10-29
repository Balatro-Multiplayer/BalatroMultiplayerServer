'use client'

import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ApiError, apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface RatingRecord {
  rating: number
  gamesPlayed: number
}

interface ReplayResponse {
  season: { id: number; name: string }
  games: number
  changedPlayers: number
  token: string
  players: {
    userId: string
    name: string
    modId: string
    mode: string
    before: RatingRecord | null
    after: RatingRecord
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

function show(record: RatingRecord | null): string {
  return record ? `${Math.round(record.rating)} (${record.gamesPlayed} games)` : '-'
}

export function SeasonReplayPanel() {
  const replayMut = useMutation<ReplayResponse>({
    mutationFn: () => apiFetch('/webadmin/ratings/season-replay', { method: 'POST' }),
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed'),
  })
  const result = replayMut.data
  const [confirming, setConfirming] = useState(false)
  const applyMut = useMutation<ApplyResponse, Error, string>({
    mutationFn: (token) =>
      apiFetch('/webadmin/ratings/season-replay/apply', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    onSettled: () => setConfirming(false),
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : e.message || 'Request failed'),
  })
  const applied = applyMut.data

  return (
    <div className='space-y-3 rounded-lg border border-border p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h2 className='text-lg font-semibold'>Season replay (dry run)</h2>
          <p className='text-sm text-muted-foreground'>
            Replays every ranked game of the current season under the current rules and shows each
            player&apos;s rating before and after. The dry run writes nothing.
          </p>
        </div>
        <Button onClick={() => {
            applyMut.reset()
            replayMut.mutate()
          }} disabled={replayMut.isPending}>
          {replayMut.isPending ? 'Replaying…' : 'Run dry run'}
        </Button>
      </div>

      {result && (
        <>
          <p className='text-sm'>
            {result.season.name}: {result.games} games replayed, {result.changedPlayers} players
            change.
          </p>
          {applied ? (
            <p className='text-sm font-medium'>
              Applied: {applied.games} games, {applied.players} players, {applied.repairedGames}{' '}
              games now rated, {applied.dismissedItems} queue items dismissed
              {applied.itemsLeftOpen > 0 && ` (${applied.itemsLeftOpen} left open)`}. Backup{' '}
              {applied.backupId}.
            </p>
          ) : (
            <Button variant='destructive' onClick={() => setConfirming(true)}>
              Apply this replay
            </Button>
          )}
          <div className='overflow-hidden rounded-lg border border-border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Player</TableHead>
                  <TableHead>Board</TableHead>
                  <TableHead>Before</TableHead>
                  <TableHead>After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.players.map((p) => (
                  <TableRow key={`${p.modId}:${p.mode}:${p.userId}`}>
                    <TableCell>{p.name || p.userId}</TableCell>
                    <TableCell>
                      {p.modId} {p.mode}
                    </TableCell>
                    <TableCell>{show(p.before)}</TableCell>
                    <TableCell>{show(p.after)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply the season replay?</AlertDialogTitle>
            <AlertDialogDescription>
              Replaces the whole season board with the numbers above
              {result ? ` (${result.games} games, ${result.changedPlayers} players change)` : ''}.
              A backup is saved first. It is refused if a ranked game is running, or if the replay
              changed since this dry run. No player is messaged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applyMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={applyMut.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (result) applyMut.mutate(result.token)
              }}
              className='bg-destructive text-white hover:bg-destructive/90'
            >
              {applyMut.isPending ? 'Applying…' : 'Apply'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
