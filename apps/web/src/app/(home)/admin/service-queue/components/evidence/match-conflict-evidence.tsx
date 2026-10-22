'use client'

import { Badge } from '@/components/ui/badge'
import {
  formatTime,
  LOBBY_KIND_LABELS,
  nameOf,
  TARGET_ROLE_LABELS,
} from '../../lib/format'
import type { MatchConflictEvidence as Evidence } from '../../lib/types'
import {
  CheckBadge,
  Empty,
  Facts,
  Placements,
  RunSummary,
  Section,
} from './shared'

export function MatchConflictEvidence({
  evidence,
  names,
}: {
  evidence: Evidence
  names: Map<string, string>
}) {
  return (
    <div className='space-y-3'>
      <Section title='Disputed result'>
        <Facts
          rows={[
            ['Game', LOBBY_KIND_LABELS[evidence.lobbyKind]],
            [
              'Mode',
              evidence.match?.gameMode ?? evidence.run?.run.gameMode ?? '—',
            ],
            ['Lobby', evidence.conflict.lobbyCode ?? '—'],
            [
              'Reported',
              formatTime(
                evidence.match?.resultReportedAt ?? evidence.conflict.createdAt
              ),
            ],
          ]}
        />
        <div className='grid gap-3 sm:grid-cols-3'>
          {evidence.sides.map((side) => (
            <div
              key={side.role}
              className='rounded border border-border p-2 text-sm'
            >
              <div className='mb-1 flex flex-wrap items-center gap-1'>
                <span className='font-semibold'>
                  {nameOf(names, side.playerId)}
                </span>
                <span className='text-muted-foreground text-xs'>
                  {TARGET_ROLE_LABELS[side.role]}
                </span>
              </div>
              <Placements placements={side.placements} names={names} />
              <Badge
                className='mt-1'
                variant={side.agreesWithResult ? 'secondary' : 'destructive'}
              >
                {side.agreesWithResult ? 'matches recorded' : 'differs'}
              </Badge>
            </div>
          ))}
          <div className='rounded border border-border border-dashed p-2 text-sm'>
            <div className='mb-1 font-semibold'>Recorded</div>
            {evidence.recorded ? (
              <>
                <Placements placements={evidence.recorded} names={names} />
                <div className='mt-1 text-muted-foreground text-xs'>
                  {evidence.recorded.some((p) => p.rated)
                    ? 'rated'
                    : 'not rated'}
                </div>
              </>
            ) : (
              <Empty>No result recorded for this match.</Empty>
            )}
          </div>
        </div>
      </Section>

      <Section title='Players'>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead className='text-muted-foreground text-xs'>
              <tr>
                <th className='py-1 pr-3 text-left font-normal'>Player</th>
                <th className='py-1 pr-3 text-left font-normal'>Log</th>
                <th className='py-1 pr-3 text-left font-normal'>Rating</th>
                <th className='py-1 pr-3 text-left font-normal'>Forfeits</th>
                <th className='py-1 text-left font-normal'>Disputes</th>
              </tr>
            </thead>
            <tbody>
              {evidence.players.map((p) => (
                <tr key={p.id} className='border-border border-t'>
                  <td className='py-1 pr-3'>
                    {p.name ?? p.id}
                    {p.flag && (
                      <Badge variant='destructive' className='ml-1'>
                        {p.flag}
                      </Badge>
                    )}
                  </td>
                  <td className='py-1 pr-3'>
                    <CheckBadge check={p.logCheck} />
                  </td>
                  <td className='py-1 pr-3'>
                    {p.ratings.length
                      ? p.ratings
                          .map(
                            (r) =>
                              `${Math.round(r.rating)} (S${r.season}, ${r.gamesPlayed} games)`
                          )
                          .join(', ')
                      : '—'}
                  </td>
                  <td className='py-1 pr-3'>{p.forfeitFlags}</td>
                  <td className='py-1'>{p.disputes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <RunSummary run={evidence.run} replay={evidence.replay} names={names} />

      <Section title='Other conflicts on this match'>
        {evidence.otherConflicts.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className='space-y-1 text-sm'>
            {evidence.otherConflicts.map((c) => (
              <li key={c.id}>
                {nameOf(names, c.firstReporterId)} vs{' '}
                {nameOf(names, c.conflictingReporterId)}{' '}
                <span className='text-muted-foreground'>({c.status})</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
