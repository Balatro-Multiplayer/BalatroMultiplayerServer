import { cn } from '@/lib/utils'
import type { IdolRoll } from '../../lib/game-log/types'

const SUIT_GLYPH: Record<string, string> = { H: '♥', D: '♦', C: '♣', S: '♠' }
const SUIT_CLASS: Record<string, string> = {
  H: 'text-[#ff4d55]',
  D: 'text-[#ff9a2e]',
  C: 'text-[#37bd76]',
  S: 'text-slate-300',
}

// The roll falls on a number line: each deck card (rank+suit) owns a slice
// sized by how many copies the deck holds, in selection order, and the card
// whose slice contains `roll` is the Idol's target for the blind. The deck
// shown here is that sorted weight list.
export function IdolTrack({ roll }: { roll: IdolRoll }) {
  const total = roll.cards.reduce((n, c) => n + c.count, 0)
  const winnerKey = roll.winner
  return (
    <div className='space-y-1 rounded-md border bg-muted/30 p-2'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <span className='font-medium'>The Idol</span>
        <span className='text-muted-foreground'>
          {roll.roll === null ? 'target' : `rolled ${roll.roll.toFixed(4)}`} →
        </span>
        <span className='font-mono font-semibold'>
          {winnerKey.slice(0, -1)}
          <span className={SUIT_CLASS[winnerKey.slice(-1)]}>
            {SUIT_GLYPH[winnerKey.slice(-1)] ?? winnerKey.slice(-1)}
          </span>
        </span>
      </div>
      <div className='relative flex h-9 overflow-hidden rounded-sm bg-[#0c1a13]'>
        {roll.cards.map((card) => {
          const key = `${card.rank === '10' ? 'T' : card.rank}${card.suit}`
          const won = key === winnerKey
          return (
            <div
              key={`${card.rank}${card.suit}`}
              className={cn(
                'flex min-w-0 flex-col items-center justify-center border-[#081410] border-r text-[10px] leading-tight',
                won && 'bg-[#ffcf5c]/25 ring-1 ring-[#ffcf5c] ring-inset'
              )}
              style={{ flexGrow: card.count, flexBasis: 0 }}
              title={`${card.rank}${SUIT_GLYPH[card.suit] ?? card.suit} · ${card.count} of ${total}`}
            >
              <span
                className={cn('font-bold font-mono', SUIT_CLASS[card.suit])}
              >
                {card.rank}
                {SUIT_GLYPH[card.suit]}
              </span>
              {card.count / total > 0.06 && (
                <span className='text-muted-foreground'>×{card.count}</span>
              )}
            </div>
          )
        })}
        {roll.roll !== null && (
          <div
            className='absolute top-0 h-full w-0.5 bg-white'
            style={{ left: `${Math.min(100, Math.max(0, roll.roll * 100))}%` }}
          />
        )}
      </div>
    </div>
  )
}
