'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface GlobalStats {
  activePlayers: number
  totalMatches: number
  uniquePlayers: number
}

interface ActivityResponse {
  buckets: { hour: string; count: number }[]
}

export default function StatsPage() {
  const { data: stats } = useQuery<GlobalStats>({
    queryKey: ['global-stats'],
    queryFn: () => apiFetch('/stats'),
    refetchInterval: 30_000,
  })

  const { data: activityData } = useQuery<ActivityResponse>({
    queryKey: ['stats-activity'],
    queryFn: () => apiFetch('/stats/activity'),
    refetchInterval: 5 * 60_000,
  })

  return (
    <div className='container py-8 space-y-8'>
      <div className='space-y-1'>
        <h1 className='text-3xl font-bold tracking-tight'>Statistics</h1>
        <p className='text-muted-foreground'>Global statistics for Balatro Multiplayer.</p>
      </div>

      {/* Global counters */}
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
        <StatCard label='Total Matches' value={stats?.totalMatches} color='text-bal-blue' />
        <StatCard label='Unique Players' value={stats?.uniquePlayers} color='text-bal-green' />
        <StatCard label='Active Players' value={stats?.activePlayers} color='text-primary' />
      </div>

      <ActivityChartCard data={activityData} />
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  return (
    <Card>
      <CardContent className='pt-6 text-center'>
        <div className={`text-4xl font-black ${color}`}>
          {value !== undefined ? value.toLocaleString() : '-'}
        </div>
        <div className='mt-1.5 text-xs uppercase tracking-wider text-muted-foreground'>{label}</div>
      </CardContent>
    </Card>
  )
}

function ActivityChartCard({ data }: { data: ActivityResponse | undefined }) {
  const buckets = data?.buckets ?? []
  const max = Math.max(1, ...buckets.map((b) => b.count))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Matches formed per hour, last 7 days.</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className='text-sm text-muted-foreground'>No recent activity.</p>
        ) : (
          <div className='flex h-32 items-end gap-px'>
            {buckets.map((b) => (
              <div
                key={b.hour}
                title={`${new Date(b.hour).toLocaleString()}: ${b.count}`}
                className='flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary'
                style={{ height: `${Math.max(2, (b.count / max) * 100)}%` }}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
