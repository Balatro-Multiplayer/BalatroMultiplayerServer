import { RankBadge } from '@/components/rank-badge'
import type { BetaPlayerRef, BetaStandingRow } from '@/lib/beta-seasons'

const HEADERS = ['Rank', 'Player', 'Rating', 'Peak', 'W', 'L', 'Games']

/** A Beta Season player: a link to their account when one is linked. */
export function BetaPlayerName({ player }: { player: BetaPlayerRef }) {
  if (!player.playerId) return <span>{player.displayName}</span>
  return (
    <a
      href={`/players/${player.playerId}`}
      className='transition-colors hover:text-primary'
    >
      {player.displayName}
    </a>
  )
}

export function BetaBoardTable({
  loading,
  entries,
}: {
  loading: boolean
  entries: BetaStandingRow[]
}) {
  if (loading)
    return <p className='p-6 text-muted-foreground text-sm'>Loading…</p>
  if (entries.length === 0)
    return (
      <p className='p-6 text-muted-foreground text-sm'>No entries found.</p>
    )
  return (
    <div className='overflow-x-auto'>
      <table className='w-full font-readable text-sm'>
        <thead>
          <tr className='border-border border-b bg-muted/40'>
            {HEADERS.map((h) => (
              <th
                key={h}
                className='px-4 py-3 text-left font-semibold text-muted-foreground text-xs uppercase tracking-wide'
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-border'>
          {entries.map((entry) => (
            <tr
              key={entry.rank}
              className='transition-colors hover:bg-muted/30'
            >
              <td className='px-4 py-3'>
                <RankBadge rank={entry.rank} />
              </td>
              <td className='px-4 py-3 font-semibold'>
                <BetaPlayerName player={entry} />
              </td>
              <td className='px-4 py-3 font-bold font-pixel text-bal-gold'>
                {Math.round(entry.rating)}
              </td>
              <td className='px-4 py-3 font-semibold text-bal-blue'>
                {entry.peakRating == null ? '-' : Math.round(entry.peakRating)}
              </td>
              <td className='px-4 py-3 text-bal-green'>{entry.wins}</td>
              <td className='px-4 py-3 text-bal-red'>{entry.losses}</td>
              <td className='px-4 py-3 text-muted-foreground'>
                {entry.gamesPlayed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
