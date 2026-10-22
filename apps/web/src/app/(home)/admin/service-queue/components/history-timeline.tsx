'use client'

import { useQuery } from '@tanstack/react-query'
import { getEvents, queueKeys } from '../lib/api'
import {
  ACTION_LABELS,
  actorText,
  EVENT_LABELS,
  formatTime,
} from '../lib/format'
import type { ActionKey } from '../lib/types'
import { Empty } from './evidence/shared'

const actionLabel = (action: string | null) =>
  action && action in ACTION_LABELS
    ? ACTION_LABELS[action as ActionKey]
    : action

// Who viewed, claimed and acted on an item, oldest first.
export function HistoryTimeline({ itemId }: { itemId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: queueKeys.events(itemId),
    queryFn: () => getEvents(itemId),
  })
  if (isLoading) return <Empty>Loading history…</Empty>
  if (!data?.events.length) return <Empty>No history yet.</Empty>
  return (
    <ol
      className='space-y-1 border-border border-l pl-3 text-sm'
      data-testid='history'
    >
      {data.events.map((e) => (
        <li key={e.id}>
          <span className='text-muted-foreground'>{formatTime(e.at)}</span>{' '}
          {actorText(e.actor, data.actorNames)} {EVENT_LABELS[e.kind]}
          {e.action && <> · {actionLabel(e.action)}</>}
          {e.note && <div className='text-muted-foreground'>“{e.note}”</div>}
        </li>
      ))}
    </ol>
  )
}
