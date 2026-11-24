'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { apiFetch, apiFetchWithReason } from '@/lib/api'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  type Counts,
  type Draft,
  type Range,
  changeCount,
  countQuery,
  draftOf,
  playersLabel,
  rangeOf,
} from '../lib/draft'

export interface QueueRow {
  modId: string
  gameMode: string
  // "PvP Expanded"
  label: string
  range: Range
  // Players rated in the queue this season.
  rated: number
  counts: Counts
}

// A draft that waits a moment after the last keystroke, so a count is asked
// for when the typing stops.
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

// One side of the queue. Both sides share the same two columns, so the rating
// boxes line up with each other and so do the multiplier boxes: a label row
// (the range, and how many players it contains) over an input row.
function Edge({
  id,
  label,
  hint,
  value,
  multiplier,
  players,
  disabled,
  onValue,
  onMultiplier,
}: {
  id: string
  label: string
  hint: string
  value: string
  multiplier: string
  players: string
  disabled: boolean
  onValue: (v: string) => void
  onMultiplier: (v: string) => void
}) {
  return (
    <div className='grid grid-cols-[minmax(0,1fr)_9rem] gap-x-3 gap-y-1'>
      <Label htmlFor={id} className='flex flex-wrap items-baseline gap-x-2'>
        {label}
        {players && (
          <span
            className='font-normal text-muted-foreground'
            data-testid={`${id}-players`}
          >
            – Contains {players}
          </span>
        )}
      </Label>
      <Label htmlFor={`${id}-wait`}>Wait multiplier</Label>
      <Input
        id={id}
        type='number'
        inputMode='numeric'
        min={0}
        max={10000}
        step={1}
        placeholder='Not set'
        value={value}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
      />
      <Input
        id={`${id}-wait`}
        type='number'
        inputMode='decimal'
        min={0.1}
        max={10}
        step={0.1}
        value={multiplier}
        disabled={disabled || value.trim() === ''}
        onChange={(e) => onMultiplier(e.target.value)}
      />
      <p className='col-span-2 text-muted-foreground text-xs'>{hint}</p>
    </div>
  )
}

// One ranked queue: a switch for the queue, its upper range (a floor) and
// lower range (a ceiling) each with the number of players it contains, and a
// save that needs a note for the staff log.
export function QueueCard({
  queue,
  onSaved,
}: {
  queue: QueueRow
  onSaved: () => void
}) {
  const saved = queue.range
  const [draft, setDraft] = useState<Draft>(draftOf(saved))
  const [note, setNote] = useState('')
  const parsed = rangeOf(draft)
  const changes = 'range' in parsed ? changeCount(saved, parsed.range) : 0

  const query = countQuery(queue.modId, queue.gameMode, useSettled(draft))
  const { data: live } = useQuery<Counts>({
    queryKey: ['instant-queue-count', query],
    queryFn: () => apiFetch(`/webadmin/instant-queue/count?${query}`),
    enabled: query !== null,
    placeholderData: (previous) => previous,
  })
  const counts: Counts = live ?? queue.counts

  const save = useMutation({
    mutationFn: (range: Range) =>
      apiFetchWithReason(
        `/webadmin/instant-queue/${encodeURIComponent(queue.modId)}/${encodeURIComponent(queue.gameMode)}`,
        { method: 'PUT', body: JSON.stringify(range) },
        note.trim()
      ),
    onSuccess: () => {
      toast.success(`${queue.label} instant queue saved`)
      setNote('')
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : 'Request failed'),
    onSettled: onSaved,
  })

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const ready = 'range' in parsed && changes > 0 && note.trim() !== ''
  const id = `${queue.modId}-${queue.gameMode}`
  const nothingSet = draft.floor.trim() === '' && draft.ceiling.trim() === ''

  return (
    <section
      className='space-y-4 rounded-lg border border-border bg-card/80 p-4'
      data-testid='instant-queue-card'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='font-bold text-xl tracking-tight'>{queue.label}</h2>
          <p className='text-muted-foreground text-xs'>
            {queue.modId} · {queue.gameMode} · {playersLabel(queue.rated)} rated
            this season
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Label htmlFor={`${id}-on`} className='font-semibold'>
            {draft.enabled ? 'On' : 'Off'}
          </Label>
          <Switch
            id={`${id}-on`}
            checked={draft.enabled}
            disabled={save.isPending}
            onCheckedChange={(enabled) => set({ enabled })}
          />
        </div>
      </div>

      {draft.enabled && nothingSet && (
        <p className='text-bal-gold text-sm'>
          This queue is on but has no floor or ceiling, so nothing changes yet.
        </p>
      )}

      <div className={draft.enabled ? 'space-y-4' : 'space-y-4 opacity-60'}>
        <Edge
          id={`${id}-floor`}
          label='Upper range floor'
          hint='Players rated at or above this queue among each other at once.'
          value={draft.floor}
          multiplier={draft.floorMultiplier}
          players={draft.floor.trim() === '' ? '' : playersLabel(counts.floor)}
          disabled={save.isPending}
          onValue={(floor) => set({ floor })}
          onMultiplier={(floorMultiplier) => set({ floorMultiplier })}
        />
        <Edge
          id={`${id}-ceiling`}
          label='Lower range ceiling'
          hint='Players rated at or below this queue among each other at once.'
          value={draft.ceiling}
          multiplier={draft.ceilingMultiplier}
          players={
            draft.ceiling.trim() === '' ? '' : playersLabel(counts.ceiling)
          }
          disabled={save.isPending}
          onValue={(ceiling) => set({ ceiling })}
          onMultiplier={(ceilingMultiplier) => set({ ceilingMultiplier })}
        />
      </div>

      <p className='text-muted-foreground text-xs'>
        Wait multiplier: a player in a range waits the time the normal window
        would take to reach the range edge, times this, before the range opens
        up. 1 is the normal wait. Leave a rating empty for no range on that
        side. The ranges only apply while the queue is On.
      </p>

      {'error' in parsed && (
        <p className='text-bal-red text-sm' role='alert'>
          {parsed.error}
        </p>
      )}

      <form
        className='flex flex-wrap items-center gap-2 border-border border-t pt-3'
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && 'range' in parsed) save.mutate(parsed.range)
        }}
      >
        {changes > 0 ? (
          <span className='rounded-full border border-bal-gold/60 bg-bal-gold/10 px-2.5 py-0.5 text-bal-gold text-xs'>
            {changes === 1 ? '1 change' : `${changes} changes`}
          </span>
        ) : (
          <span className='text-muted-foreground text-xs'>No changes</span>
        )}
        <Input
          aria-label='Note for the staff log'
          placeholder='Note for the staff log (needed)'
          value={note}
          disabled={save.isPending || changes === 0}
          onChange={(e) => setNote(e.target.value)}
          className='min-w-48 flex-1'
        />
        <Button
          type='button'
          variant='outline'
          disabled={save.isPending || changes === 0}
          onClick={() => {
            setDraft(draftOf(saved))
            setNote('')
          }}
        >
          Reset
        </Button>
        <Button type='submit' disabled={!ready || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </section>
  )
}
