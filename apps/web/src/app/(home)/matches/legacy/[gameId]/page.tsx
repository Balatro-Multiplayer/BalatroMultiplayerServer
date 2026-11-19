'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { ApiError, apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { GameLogView } from '../../components/game-log/game-log-view'
import { PlayerLabel } from '../../components/player-label'
import { ShareButtons } from '../../components/share-buttons'
import { decodePlayerLogs } from '../../lib/decode-player-logs'
import { buildGameLog } from '../../lib/game-log/build-game-log'
import {
  hiddenPlayerIds,
  legacyMatchPath,
  shareControl,
  withOwnSideShared,
} from '../../lib/match-view'
import type { LegacyGameResponse } from '../../lib/types'

/** A game from the legacy website's uploaded logs, in the match view. */
export default function LegacyMatchPage() {
  const { pending, player, isLoggedIn } = useAuth()
  const gameId = useParams().gameId as string
  const queryClient = useQueryClient()
  const queryKey = ['legacy-game', gameId, player?.id ?? null]

  const { data, error, isLoading } = useQuery<LegacyGameResponse>({
    queryKey,
    queryFn: () => apiFetch(`/legacy-games/${gameId}`),
    enabled: !pending,
    retry: false,
  })

  const shareMutation = useMutation({
    mutationFn: (share: boolean) =>
      apiFetch<{ shared: boolean }>(`/legacy-games/${gameId}/share`, {
        method: share ? 'POST' : 'DELETE',
      }),
    onSuccess: ({ shared }) =>
      queryClient.setQueryData<LegacyGameResponse>(queryKey, (old) =>
        old ? { ...old, ...withOwnSideShared(old, shared) } : old
      ),
  })

  const { decoded, failures } = useMemo(
    () => decodePlayerLogs(data?.logs ?? []),
    [data]
  )
  const gameLog = useMemo(() => buildGameLog(decoded), [decoded])
  const hidden = useMemo(() => hiddenPlayerIds(data?.logs ?? []), [data])
  const names = useMemo(
    () => new Map((data?.logs ?? []).map((l) => [l.playerId, l.displayName])),
    [data]
  )

  const message =
    error instanceof ApiError && error.status === 404
      ? 'Match not found.'
      : error
        ? 'Failed to load this match. Please try again later.'
        : pending || isLoading || !data
          ? 'Loading…'
          : null

  const back = isLoggedIn && (
    <Link href='/matches' className='text-bal-blue text-sm hover:underline'>
      ← Back to My Matches
    </Link>
  )

  if (message || !data) {
    return (
      <div className='container max-w-lg space-y-4 py-8'>
        {back}
        <p className='text-muted-foreground'>{message}</p>
      </div>
    )
  }

  const { legacy } = data
  const share = shareControl(data)
  const started = new Date(data.run.startedAt)
  const details = [
    legacy.deck,
    legacy.stake,
    legacy.seed && `Seed ${legacy.seed}`,
    legacy.beta && `Beta Season ${legacy.beta.season}`,
  ].filter(Boolean)

  return (
    <div className='container max-w-6xl space-y-6 py-8'>
      <div className='space-y-1'>
        {back}
        <div className='flex flex-wrap items-center gap-3'>
          <h1 className='font-bold text-2xl tracking-tight'>
            Legacy Match Log
          </h1>
          {share && (
            <ShareButtons
              link={() =>
                `${window.location.origin}${legacyMatchPath(legacy.id)}`
              }
              shared={share.shared}
              busy={shareMutation.isPending}
              onToggle={() => shareMutation.mutate(!share.shared)}
            />
          )}
        </div>
        <p className='text-muted-foreground text-sm'>
          {legacy.timeExact
            ? started.toLocaleString()
            : `${started.toLocaleDateString()} (time of day unknown)`}
          {details.length > 0 && ` · ${details.join(' · ')}`}
        </p>
        <p className='text-muted-foreground text-xs'>
          From a log uploaded to the old website. Old logs did not record which
          cards were played, so hands show only their positions and scores. The
          opponent side holds only what the uploader's game knew about them.
        </p>
        {share && (
          <p className='text-muted-foreground text-xs'>
            {share.shared
              ? 'This game is shared. Anyone with the link can see your side.'
              : 'Only you can see this game. Share it to let anyone with the link see your side.'}
          </p>
        )}
        {shareMutation.isError && (
          <p className='text-destructive text-sm'>
            Could not change sharing. Please try again.
          </p>
        )}
      </div>

      {failures.length > 0 && (
        <Card className='border-destructive/40'>
          <CardContent className='space-y-1 pt-6 text-destructive text-sm'>
            {failures.map((f) => (
              <p key={f.playerId}>
                {names.get(f.playerId) ?? 'A side'}: {f.error}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <GameLogView
        log={gameLog}
        hiddenPlayerIds={hidden}
        playerLabel={(id) => (
          <PlayerLabel
            playerId={id}
            displayName={names.get(id)}
            viewerId={data.viewer.playerId ?? null}
          />
        )}
      />
    </div>
  )
}
