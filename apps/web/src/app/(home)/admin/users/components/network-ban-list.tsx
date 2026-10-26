import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// A network ban (ADR 0005), from Nakama. own: it came from this player's own
// permanent account ban; otherwise it covers a network this player used.
export interface NetworkBan {
  banId: string
  own: boolean
  networks: number
  bannedAt: number
  liftedAt: number | null
}

export function NetworkBanList({
  networkBans,
  unavailable,
  canLift,
  liftPending,
  onLift,
}: {
  networkBans: NetworkBan[]
  unavailable: boolean
  canLift: boolean
  liftPending: boolean
  onLift: (banId: string) => void
}) {
  if (unavailable) {
    return <p className='text-sm text-muted-foreground'>Network bans are unavailable (Nakama did not answer).</p>
  }
  if (networkBans.length === 0) {
    return <p className='text-sm text-muted-foreground'>No network bans touch this player.</p>
  }

  return (
    <div className='space-y-2'>
      {networkBans.map((ban) => {
        const active = ban.liftedAt === null
        return (
          <div
            key={ban.banId}
            className='flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm'
          >
            <div className='space-y-0.5'>
              <div className='flex items-center gap-2'>
                <Badge variant={active ? 'destructive' : 'outline'}>network</Badge>
                {!active && <span className='text-xs text-muted-foreground'>lifted</span>}
              </div>
              <p className='text-muted-foreground'>
                {ban.own
                  ? 'From this player\'s permanent account ban'
                  : 'Covers a network this player logged in from'}
                {active && ` (${ban.networks} ${ban.networks === 1 ? 'network' : 'networks'})`}
              </p>
              <p className='font-mono text-xs text-muted-foreground'>
                ban {ban.banId}, since {new Date(ban.bannedAt).toLocaleDateString()}
              </p>
            </div>
            {active && canLift && (
              <Button variant='outline' size='sm' onClick={() => onLift(ban.banId)} disabled={liftPending}>
                Lift
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
