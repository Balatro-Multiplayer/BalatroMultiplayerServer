'use client'

import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiFetch } from '@/lib/api'
import { legacyMatchPath } from '../lib/match-view'
import type { MyLegacyGamesResponse } from '../lib/types'

const PAGE_SIZE = 20

const RESULT = {
  win: { label: 'Win', className: 'text-bal-green' },
  loss: { label: 'Loss', className: 'text-bal-red' },
} as const

/**
 * The player's games from logs they uploaded to the old website. Shown only
 * when their account has that Discord account linked and it has games.
 */
export function LegacyGamesList() {
  const [page, setPage] = useState(1)
  const { data } = useQuery<MyLegacyGamesResponse>({
    queryKey: ['my-legacy-games', page],
    queryFn: () =>
      apiFetch(`/legacy-games/mine?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: (prev) => prev,
  })
  const total = data?.total ?? 0
  if (total === 0) return null
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Legacy Matches</CardTitle>
        <p className='text-muted-foreground text-sm'>
          {total} games from logs you uploaded to the old website.
        </p>
      </CardHeader>
      <CardContent className='p-0'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Opponent</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Deck</TableHead>
              <TableHead>Shared</TableHead>
              <TableHead className='text-right'>Replay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.games ?? []).map((g) => (
              <TableRow key={g.id}>
                <TableCell className='text-muted-foreground'>
                  {format(
                    new Date(g.startedAt),
                    g.timeExact ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy'
                  )}
                </TableCell>
                <TableCell>{g.opponentName ?? '-'}</TableCell>
                <TableCell
                  className={g.result ? RESULT[g.result].className : undefined}
                >
                  {g.result ? RESULT[g.result].label : '-'}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {g.deck ?? '-'}
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {g.shared ? 'Yes' : 'No'}
                </TableCell>
                <TableCell className='text-right'>
                  <Button variant='outline' size='sm' asChild>
                    <Link href={legacyMatchPath(g.id)}>View Log</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {totalPages > 1 && (
          <div className='flex items-center justify-end gap-2 border-border border-t px-4 py-3'>
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
        )}
      </CardContent>
    </Card>
  )
}
