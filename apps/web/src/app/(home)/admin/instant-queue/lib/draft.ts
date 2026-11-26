// The instant queue panel's drafts: what is typed in the number boxes, and
// what a save sends. Pure: the panel holds the state.
export interface Range {
  // The queue's ranges apply only while on; the values are kept when off.
  enabled: boolean
  floor: number | null
  ceiling: number | null
  floorMultiplier: number
  ceilingMultiplier: number
}

export interface Draft {
  enabled: boolean
  floor: string
  ceiling: string
  floorMultiplier: string
  ceilingMultiplier: string
}

export interface Counts {
  floor: number | null
  ceiling: number | null
}

export const MAX_RATING = 10000
export const MIN_MULTIPLIER = 0.1
export const MAX_MULTIPLIER = 10

export function draftOf(range: Range): Draft {
  return {
    enabled: range.enabled,
    floor: range.floor === null ? '' : String(range.floor),
    ceiling: range.ceiling === null ? '' : String(range.ceiling),
    floorMultiplier: String(range.floorMultiplier),
    ceilingMultiplier: String(range.ceilingMultiplier),
  }
}

// A rating box: empty is no edge; otherwise a whole rating in range, else
// undefined.
export function parseEdge(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return n <= MAX_RATING ? n : undefined
}

export function parseMultiplier(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined
  const n = Number(t)
  return n >= MIN_MULTIPLIER && n <= MAX_MULTIPLIER ? n : undefined
}

// The draft as a range, or the first thing wrong with it.
export function rangeOf(draft: Draft): { range: Range } | { error: string } {
  const floor = parseEdge(draft.floor)
  if (floor === undefined)
    return { error: `Floor must be a whole rating from 0 to ${MAX_RATING}.` }
  const ceiling = parseEdge(draft.ceiling)
  if (ceiling === undefined)
    return { error: `Ceiling must be a whole rating from 0 to ${MAX_RATING}.` }
  const floorMultiplier = parseMultiplier(draft.floorMultiplier)
  if (floorMultiplier === undefined)
    return {
      error: `Upper wait multiplier must be from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}.`,
    }
  const ceilingMultiplier = parseMultiplier(draft.ceilingMultiplier)
  if (ceilingMultiplier === undefined)
    return {
      error: `Lower wait multiplier must be from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}.`,
    }
  if (floor !== null && ceiling !== null && ceiling >= floor)
    return { error: 'The ceiling must be below the floor.' }
  return {
    range: {
      enabled: draft.enabled,
      floor,
      ceiling,
      floorMultiplier,
      ceilingMultiplier,
    },
  }
}

// How many things differ from the saved range: the switch, the edges, and a
// multiplier only while its edge is set.
export function changeCount(saved: Range, next: Range): number {
  let n = 0
  if (saved.enabled !== next.enabled) n++
  if (saved.floor !== next.floor) n++
  if (saved.ceiling !== next.ceiling) n++
  if (next.floor !== null && saved.floorMultiplier !== next.floorMultiplier) n++
  if (next.ceiling !== null && saved.ceilingMultiplier !== next.ceilingMultiplier)
    n++
  return n
}

export function playersLabel(count: number | null | undefined): string {
  if (count === null || count === undefined) return ''
  return count === 1 ? '1 player' : `${count.toLocaleString('en-US')} players`
}

// The query for the count of the edges typed, or null when there is nothing
// valid to count.
export function countQuery(
  modId: string,
  gameMode: string,
  draft: Draft
): string | null {
  const floor = parseEdge(draft.floor)
  const ceiling = parseEdge(draft.ceiling)
  if (floor === undefined || ceiling === undefined) return null
  if (floor === null && ceiling === null) return null
  const q = new URLSearchParams({ modId, gameMode })
  if (floor !== null) q.set('floor', String(floor))
  if (ceiling !== null) q.set('ceiling', String(ceiling))
  return q.toString()
}
