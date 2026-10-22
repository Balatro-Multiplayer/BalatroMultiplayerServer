'use client'

import { Badge } from '@/components/ui/badge'
import { formatTime, nameOf, REPORT_TYPE_LABELS } from '../../lib/format'
import type { ReportEvidence as Evidence } from '../../lib/types'
import { ChatTail, Empty, Facts, RunSummary, Section } from './shared'

export function ReportEvidence({
  evidence,
  names,
}: {
  evidence: Evidence
  names: Map<string, string>
}) {
  const { report } = evidence
  return (
    <div className='space-y-3'>
      <Section title='Report'>
        <Facts
          rows={[
            [
              'Reason',
              <Badge key='r' variant='outline'>
                {REPORT_TYPE_LABELS[report.type] ?? report.type}
              </Badge>,
            ],
            ['Reporter', evidence.reporter.name ?? evidence.reporter.id],
            ['Reported', evidence.reported.name ?? evidence.reported.id],
            ['Lobby', report.lobbyCode ?? '—'],
            ['Filed', formatTime(report.createdAt)],
          ]}
        />
        {report.message && (
          <blockquote className='border-border border-l-2 pl-3 text-sm'>
            {report.message}
          </blockquote>
        )}
        {report.additionalDetail && (
          <p className='text-muted-foreground text-sm'>
            {report.additionalDetail}
          </p>
        )}
      </Section>

      <Section title='Lobby chat'>
        <ChatTail lines={evidence.chat} />
      </Section>

      <RunSummary run={evidence.run} replay={evidence.replay} names={names} />

      <Section title='Other reports in this lobby or run'>
        {evidence.related.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className='space-y-1 text-sm'>
            {evidence.related.map((r) => (
              <li key={r.id}>
                <Badge variant='outline'>
                  {REPORT_TYPE_LABELS[r.type] ?? r.type}
                </Badge>{' '}
                {nameOf(names, r.reporterId)} → {nameOf(names, r.reportedId)}
                {r.reporterId === report.reportedId &&
                  r.reportedId === report.reporterId && (
                    <Badge variant='secondary' className='ml-2'>
                      counter-report
                    </Badge>
                  )}{' '}
                <span className='text-muted-foreground'>({r.status})</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
