// The Instant queue access card: the 'instaqueue' privilege lets a player edit
// the instant queue ranges without being staff. Pure: the card holds the state.
export const INSTANT_QUEUE_PRIVILEGE = 'instaqueue'

export function holdsInstantQueue(privileges: readonly string[]): boolean {
  return privileges.includes(INSTANT_QUEUE_PRIVILEGE)
}

// The new privilege list: every other privilege stays.
export function privilegesWithInstantQueue(
  privileges: readonly string[],
  grant: boolean
): string[] {
  const kept = privileges.filter((p) => p !== INSTANT_QUEUE_PRIVILEGE)
  return grant ? [...kept, INSTANT_QUEUE_PRIVILEGE] : kept
}

// A change needs a note.
export function instantQueueAccessError(note: string): string | null {
  return note.trim() ? null : 'A change needs a note.'
}
