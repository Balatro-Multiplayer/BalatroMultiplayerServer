'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  holdsInstantQueue,
  instantQueueAccessError,
  privilegesWithInstantQueue,
} from '../lib/instant-queue-access'

// Admins only: give or take away the 'instaqueue' privilege, which opens the
// Instant Queue page to a player who is not staff. The change needs a note and
// goes in the staff log.
export function InstantQueueAccessCard({
  playerId,
  privileges,
}: {
  playerId: string
  privileges: string[]
}) {
  const qc = useQueryClient()
  const holds = holdsInstantQueue(privileges)
  const [note, setNote] = useState('')
  const problem = instantQueueAccessError(note)

  const change = useMutation({
    mutationFn: () =>
      apiFetch(`/webadmin/players/${playerId}/privileges`, {
        method: 'PATCH',
        body: JSON.stringify({
          privileges: privilegesWithInstantQueue(privileges, !holds),
          reason: note.trim(),
        }),
      }),
    onSuccess: () => {
      setNote('')
      qc.invalidateQueries({ queryKey: ['admin-player-page', playerId] })
      qc.invalidateQueries({ queryKey: ['admin-player-log', playerId] })
    },
  })

  return (
    <section
      className='space-y-3 rounded-lg border border-border bg-card/80 p-4'
      data-testid='instant-queue-access-card'
    >
      <h3 className='font-pixel text-lg uppercase tracking-wide'>
        Instant queue access
        <span className='ml-2 rounded border border-bal-gold px-1 text-bal-gold text-xs'>
          Admin
        </span>
      </h3>
      <p className='text-muted-foreground text-sm'>
        {holds
          ? 'This player can edit the instant queue ranges.'
          : 'This player cannot edit the instant queue ranges.'}
      </p>
      <Input
        placeholder='Note for the staff log'
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label='Note for the access change'
      />
      {change.error && (
        <p className='text-bal-red text-sm' role='alert'>
          {change.error.message}
        </p>
      )}
      <Button
        size='sm'
        variant={holds ? 'destructive' : 'default'}
        disabled={problem !== null || change.isPending}
        title={problem ?? undefined}
        onClick={() => change.mutate()}
      >
        {change.isPending ? 'Saving…' : holds ? 'Remove access' : 'Give access'}
      </Button>
    </section>
  )
}
