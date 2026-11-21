'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  RatingChangesTable,
  type RatingSnapshot,
} from '@/components/admin/rating-changes-table'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { playerHref } from '../../service-queue/lib/links'

interface RatingChange {
  userId: string
  playerId: string | null
  name: string
  modId: string
  mode: string
  before: RatingSnapshot | null
  after: RatingSnapshot
}

// A Season replay apply's per-player rating changes, fetched when opened: the
// list can run to thousands of rows.
export function RatingChanges({
  entryId,
  count,
}: {
  entryId: number
  count: number
}) {
  const [open, setOpen] = useState(false)
  const { data, isPending, isError } = useQuery<{ changes: RatingChange[] }>({
    queryKey: ['admin-staff-log-rating-changes', entryId],
    queryFn: () => apiFetch(`/webadmin/staff-log/${entryId}/rating-changes`),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return (
    <div className='space-y-2 md:col-span-6'>
      <Button variant='outline' size='sm' onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} {count.toLocaleString()} rating changes
      </Button>
      {open &&
        (isError ? (
          <p className='text-red-300 text-sm'>
            Could not load the rating changes.
          </p>
        ) : isPending ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : (
          <RatingChangesTable
            rows={data.changes.map((c) => ({
              key: `${c.modId}:${c.mode}:${c.userId}`,
              name: c.name || c.userId,
              href: c.playerId ? playerHref(c.playerId) : null,
              board: `${c.modId} ${c.mode}`,
              before: c.before,
              after: c.after,
            }))}
          />
        ))}
    </div>
  )
}
