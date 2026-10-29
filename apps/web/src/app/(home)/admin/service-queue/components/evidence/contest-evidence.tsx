'use client'

import { Badge } from '@/components/ui/badge'
import { LOBBY_KIND_LABELS, TARGET_ROLE_LABELS } from '../../lib/format'
import type { ContestEvidence as Evidence } from '../../lib/types'
import {
  CheckBadge,
  Empty,
  Facts,
  Placements,
  RunSummary,
  Section,
} from './shared'

export function ContestEvidence({
  evidence,
  names,
}: {
  evidence: Evidence
  names: Map<string, string>
}) {
  return (
    <div className='space-y-3'>
      <Section title='Contested match'>
        <Facts
          rows={[
            ['Game', LOBBY_KIND_LABELS[evidence.lobbyKind]],
            [
              'Mode',
              evidence.match?.gameMode ?? evidence.run?.run.gameMode ?? '-',
            ],
            ['Run', evidence.runId],
          ]}
        />
        <div className='rounded border border-border border-dashed p-2 text-sm'>
          <div className='mb-1 font-semibold'>Reported before the contest</div>
          {evidence.recorded && evidence.recorded.length > 0 ? (
            <>
              <Placements placements={evidence.recorded} names={names} />
              <div className='mt-1 text-muted-foreground text-xs'>
                Held: not rated until you decide. Dismiss rates this result.
              </div>
            </>
          ) : (
            <Empty>Nobody reported a result before the contest.</Empty>
          )}
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
                <th className='py-1 text-left font-normal'>Contests started</th>
              </tr>
            </thead>
            <tbody>
              {evidence.players.map((p) => (
                <tr key={p.id} className='border-border border-t'>
                  <td className='py-1 pr-3'>
                    {p.name ?? p.id}
                    {p.role && (
                      <Badge variant='secondary' className='ml-1'>
                        {TARGET_ROLE_LABELS[p.role]}
                      </Badge>
                    )}
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
                      : '-'}
                  </td>
                  <td className='py-1'>{p.contestsStarted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <RunSummary run={evidence.run} replay={evidence.replay} names={names} />
    </div>
  )
}
