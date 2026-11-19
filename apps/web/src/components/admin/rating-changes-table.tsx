import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// Each player's rating before and after a Season replay: the owner's dry run
// and the staff log entry of an apply both show it.

export interface RatingSnapshot {
  rating: number
  gamesPlayed: number
}

export interface RatingChangeRow {
  key: string
  name: string
  // The player's admin page, when they have a website account.
  href: string | null
  board: string
  before: RatingSnapshot | null
  after: RatingSnapshot
}

function formatSnapshot(snapshot: RatingSnapshot | null): string {
  return snapshot
    ? `${Math.round(snapshot.rating)} (${snapshot.gamesPlayed} games)`
    : '-'
}

export function changeOf(
  row: Pick<RatingChangeRow, 'before' | 'after'>
): string {
  if (!row.before) return 'new'
  const delta = Math.round(row.after.rating) - Math.round(row.before.rating)
  return delta > 0 ? `+${delta}` : String(delta)
}

export function RatingChangesTable({ rows }: { rows: RatingChangeRow[] }) {
  return (
    <div className='overflow-hidden rounded-lg border border-border'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Player</TableHead>
            <TableHead>Board</TableHead>
            <TableHead>Before</TableHead>
            <TableHead>After</TableHead>
            <TableHead>Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                {row.href ? (
                  <Link
                    href={row.href}
                    className='text-bal-blue hover:underline'
                  >
                    {row.name}
                  </Link>
                ) : (
                  row.name
                )}
              </TableCell>
              <TableCell>{row.board}</TableCell>
              <TableCell>{formatSnapshot(row.before)}</TableCell>
              <TableCell>{formatSnapshot(row.after)}</TableCell>
              <TableCell className='font-mono'>{changeOf(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
