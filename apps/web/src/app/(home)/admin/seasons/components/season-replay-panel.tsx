'use client'

import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
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
  players: {
    userId: string
    name: string
    modId: string
    mode: string
    before: RatingRecord | null
    after: RatingRecord
  }[]
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

  return (
    <div className='space-y-3 rounded-lg border border-border p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h2 className='text-lg font-semibold'>Season replay (dry run)</h2>
          <p className='text-sm text-muted-foreground'>
            Replays every ranked game of the current season under the current rules and shows each
            player&apos;s rating before and after. Nothing is written.
          </p>
        </div>
        <Button onClick={() => replayMut.mutate()} disabled={replayMut.isPending}>
          {replayMut.isPending ? 'Replaying…' : 'Run dry run'}
        </Button>
      </div>

      {result && (
        <>
          <p className='text-sm'>
            {result.season.name}: {result.games} games replayed, {result.changedPlayers} players
            change.
          </p>
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
    </div>
  )
}
