'use client'

import { Badge } from '@/components/ui/badge'
import { formatDuration, formatTime, LOBBY_KIND_LABELS } from '../../lib/format'
import type {
  ForfeitEvidence as Evidence,
  TimelineEvent,
} from '../../lib/types'
import { Empty, Facts, Placements, RunSummary, Section } from './shared'

const TIMELINE_LABELS: Record<TimelineEvent, string> = {
  started: 'Game started',
  forfeited: 'Grace ran out: forfeited',
  reconnected: 'Player came back',
  ended: 'Game ended',
}

export function ForfeitEvidence({
  evidence,
  names,
}: {
  evidence: Evidence
  names: Map<string, string>
}) {
  const lateBy =
    new Date(evidence.flag.reconnectedAt).getTime() -
    new Date(evidence.flag.forfeitedAt).getTime()
  return (
    <div className='space-y-3'>
      <Section title='Timeline'>
        <Facts
          rows={[
            ['Game', LOBBY_KIND_LABELS[evidence.lobbyKind]],
            ['Mode', evidence.match?.gameMode ?? '—'],
            ['Lobby', evidence.flag.lobbyCode ?? '—'],
            ['Back after forfeit', formatDuration(lateBy)],
          ]}
        />
        <ol className='space-y-1 border-border border-l pl-3 text-sm'>
          {evidence.timeline.map((t) => (
            <li key={`${t.event}-${t.at}`}>
              <span className='text-muted-foreground'>{formatTime(t.at)}</span>{' '}
              {TIMELINE_LABELS[t.event]}
            </li>
          ))}
        </ol>
      </Section>

      <Section title='Result'>
        {evidence.result ? (
          <div className='space-y-1 text-sm'>
            <Badge variant='outline'>{evidence.result.status}</Badge>
            <Placements placements={evidence.result.placements} names={names} />
          </div>
        ) : (
          <Empty>No result recorded.</Empty>
        )}
      </Section>

      <RunSummary run={evidence.run} replay={evidence.replay} names={names} />

      <Section title='Forfeit history'>
        {evidence.history.length === 0 ? (
          <Empty>No earlier late returns.</Empty>
        ) : (
          <ul className='space-y-1 text-sm'>
            {evidence.history.map((h) => (
              <li key={h.id}>
                {formatTime(h.forfeitedAt)}{' '}
                <span className='text-muted-foreground'>({h.status})</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
