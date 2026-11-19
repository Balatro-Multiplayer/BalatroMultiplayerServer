import { Badge } from '@/components/ui/badge'

/** #1-#3 as medal badges, every other rank as plain text. */
export function RankBadge({ rank }: { rank: number }) {
  if (rank === 1)
    return (
      <Badge className='border-yellow-500/30 bg-yellow-500/20 text-bal-gold'>
        #1
      </Badge>
    )
  if (rank === 2)
    return (
      <Badge className='border-slate-400/30 bg-slate-400/20 text-slate-300'>
        #2
      </Badge>
    )
  if (rank === 3)
    return (
      <Badge className='border-amber-700/30 bg-amber-700/20 text-bal-orange'>
        #3
      </Badge>
    )
  return <span className='text-muted-foreground text-sm'>#{rank}</span>
}
