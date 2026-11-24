'use client'

import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { QueueCard, type QueueRow } from './components/queue-card'

// PvP Expanded is the page the tab opens on.
const DEFAULT_QUEUE = 'MultiplayerPvP:pvp_ranked_expanded'

const keyOf = (q: Pick<QueueRow, 'modId' | 'gameMode'>) =>
  `${q.modId}:${q.gameMode}`

// A queue whose ranges are on and have an edge.
const isLive = (q: QueueRow) =>
  q.range.enabled && (q.range.floor !== null || q.range.ceiling !== null)

// Open to admins and to the 'instaqueue' privilege, staff or not: the server
// checks the same (webadmin/instant-queue.route.ts).
export default function InstantQueuePage() {
  const { canEditInstantQueue, pending } = useAuth()
  const router = useRouter()
  const qc = useQueryClient()
  const [picked, setPicked] = useState(DEFAULT_QUEUE)

  useEffect(() => {
    if (!pending && !canEditInstantQueue) router.replace('/')
  }, [pending, canEditInstantQueue, router])

  const { data, isLoading, error } = useQuery<{ queues: QueueRow[] }>({
    queryKey: ['admin-instant-queue'],
    queryFn: () => apiFetch('/webadmin/instant-queue'),
    enabled: canEditInstantQueue,
  })

  if (pending || !canEditInstantQueue) return null

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-instant-queue'] })
    qc.invalidateQueries({ queryKey: ['instant-queue-count'] })
  }

  const queues = data?.queues ?? []
  const current = queues.find((q) => keyOf(q) === picked) ?? queues[0]

  return (
    <div className='mx-auto w-full max-w-4xl space-y-4 px-4 py-6'>
      <div className='text-muted-foreground text-sm'>
        Staff / Ops / <span className='text-bal-blue'>Instant Queue</span>
      </div>
      <div className='flex flex-wrap items-end gap-x-4 gap-y-1'>
        <h1 className='font-bold text-3xl tracking-tight'>Instant Queue</h1>
        <p className='text-muted-foreground text-sm'>
          For each ranked queue, the highest and lowest ratings that match each
          other without waiting for the normal window to grow. Every queue has
          its own switch. Saves take effect at once and go in the staff log.
          Players on an old game version keep the normal window.
        </p>
      </div>

      {isLoading && <p className='text-muted-foreground text-sm'>Loading…</p>}
      {error && (
        <p className='text-bal-red text-sm' role='alert'>
          {error.message}
        </p>
      )}

      {queues.length > 0 && (
        <div
          role='tablist'
          aria-label='Ranked queues'
          className='flex flex-wrap gap-1'
        >
          {queues.map((q) => {
            const selected = current !== undefined && keyOf(q) === keyOf(current)
            return (
              <button
                key={keyOf(q)}
                type='button'
                role='tab'
                aria-selected={selected}
                onClick={() => setPicked(keyOf(q))}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                  selected
                    ? 'border-bal-blue bg-bal-blue/20 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted'
                )}
              >
                {q.label}
                <span
                  title={isLive(q) ? 'On' : 'Off'}
                  className={cn(
                    'size-2 rounded-full',
                    isLive(q) ? 'bg-green-500' : 'bg-muted-foreground/40'
                  )}
                />
              </button>
            )
          })}
        </div>
      )}

      {current && (
        <QueueCard
          key={`${keyOf(current)}:${JSON.stringify(current.range)}`}
          queue={current}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
