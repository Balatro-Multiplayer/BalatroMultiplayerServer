'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch, apiFetchWithReason } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  COCKTAIL_DECKS,
  MAX_DECKS,
  MAX_NAME,
  type Recipe,
  deckLabel,
  recipeOf,
  sameRecipe,
} from './lib/recipe'

const queryKey = ['admin-ranked-cocktail']

// What the in-game Ranked queue plays when no recipe is set (the mod's own).
const BUILT_IN: Recipe = {
  name: "Bean's Cocktail",
  decks: ['b_abandoned', 'b_erratic', 'b_checkered'],
}

const slotsOf = (r: Recipe) =>
  Array.from({ length: MAX_DECKS }, (_, i) => r.decks[i] ?? '')

const describe = (r: Recipe) => `${r.name} (${r.decks.map(deckLabel).join(', ')})`

// Admin only: the server sends nobody else anything from it.
export default function RankedCocktailPage() {
  const { isAdmin, pending } = useAuth()
  const router = useRouter()
  const qc = useQueryClient()

  useEffect(() => {
    if (!pending && !isAdmin) router.replace('/')
  }, [pending, isAdmin, router])

  const { data, isLoading, error } = useQuery<{ recipe: Recipe | null }>({
    queryKey,
    queryFn: () => apiFetch('/webadmin/ranked-cocktail'),
    enabled: isAdmin,
  })

  if (pending || !isAdmin) return null

  return (
    <div className='mx-auto w-full max-w-3xl space-y-4 px-4 py-6'>
      <div className='text-muted-foreground text-sm'>
        Staff / Ops / <span className='text-bal-blue'>Ranked Cocktail</span>
      </div>
      <div className='flex flex-wrap items-end gap-x-4 gap-y-1'>
        <h1 className='font-bold text-3xl tracking-tight'>Ranked Cocktail</h1>
        <p className='text-muted-foreground text-sm'>
          The Cocktail deck Ranked games play: its name and one to three decks
          whose effects it combines. A save applies to games that start after
          it and goes in the staff log. With no saved recipe the game plays its
          built-in one.
        </p>
      </div>
      {isLoading && <p className='text-muted-foreground text-sm'>Loading…</p>}
      {error && (
        <p className='text-bal-red text-sm' role='alert'>
          {error.message}
        </p>
      )}
      {data && (
        <RecipeCard
          // Remount when the saved recipe changes so the draft restarts from it.
          key={JSON.stringify(data.recipe)}
          saved={data.recipe}
          onChanged={() => qc.invalidateQueries({ queryKey })}
        />
      )}
    </div>
  )
}

function RecipeCard({
  saved,
  onChanged,
}: {
  saved: Recipe | null
  onChanged: () => void
}) {
  const start = saved ?? BUILT_IN
  const [name, setName] = useState(start.name)
  const [slots, setSlots] = useState<string[]>(slotsOf(start))
  const [note, setNote] = useState('')

  const parsed = recipeOf(name, slots)
  const changed = 'recipe' in parsed && !sameRecipe(saved, parsed.recipe)

  const save = useMutation({
    mutationFn: (recipe: Recipe) =>
      apiFetchWithReason(
        '/webadmin/ranked-cocktail',
        { method: 'PUT', body: JSON.stringify(recipe) },
        note.trim()
      ),
    onSuccess: () => {
      toast.success('Ranked Cocktail saved')
      setNote('')
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : 'Request failed'),
    onSettled: onChanged,
  })
  const reset = useMutation({
    mutationFn: () =>
      apiFetchWithReason(
        '/webadmin/ranked-cocktail',
        { method: 'DELETE' },
        note.trim()
      ),
    onSuccess: () => {
      toast.success('Ranked Cocktail is back to the built-in recipe')
      setNote('')
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : 'Request failed'),
    onSettled: onChanged,
  })
  const busy = save.isPending || reset.isPending
  const hasNote = note.trim() !== ''

  return (
    <section
      className='space-y-4 rounded-lg border border-border bg-card/80 p-4'
      data-testid='ranked-cocktail-card'
    >
      <p className='text-muted-foreground text-xs'>
        Now playing:{' '}
        <span className='text-foreground'>
          {saved ? describe(saved) : `${describe(BUILT_IN)}, the built-in recipe`}
        </span>
      </p>

      <div className='space-y-1'>
        <Label htmlFor='cocktail-name'>Name</Label>
        <Input
          id='cocktail-name'
          value={name}
          maxLength={MAX_NAME}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className='grid gap-3 sm:grid-cols-3'>
        {slots.map((slot, i) => (
          <div key={i} className='space-y-1'>
            <Label htmlFor={`cocktail-deck-${i}`}>
              Deck {i + 1}
              {i > 0 && (
                <span className='font-normal text-muted-foreground'>
                  {' '}
                  (optional)
                </span>
              )}
            </Label>
            <select
              id={`cocktail-deck-${i}`}
              value={slot}
              disabled={busy}
              onChange={(e) =>
                setSlots((s) => s.map((v, j) => (j === i ? e.target.value : v)))
              }
              className='h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm'
            >
              <option value=''>{i === 0 ? 'Pick a deck' : 'None'}</option>
              {COCKTAIL_DECKS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {'error' in parsed && (
        <p className='text-bal-red text-sm' role='alert'>
          {parsed.error}
        </p>
      )}

      <form
        className='flex flex-wrap items-center gap-2 border-border border-t pt-3'
        onSubmit={(e) => {
          e.preventDefault()
          if (changed && hasNote && 'recipe' in parsed)
            save.mutate(parsed.recipe)
        }}
      >
        <Input
          aria-label='Note for the staff log'
          placeholder='Note for the staff log (needed)'
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          className='min-w-48 flex-1'
        />
        <Button
          type='button'
          variant='outline'
          disabled={busy || saved === null || !hasNote}
          title='Go back to the built-in recipe'
          onClick={() => reset.mutate()}
        >
          Use built-in
        </Button>
        <Button type='submit' disabled={busy || !changed || !hasNote}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </section>
  )
}
