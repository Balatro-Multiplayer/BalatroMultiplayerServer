// How a ban's end reads for staff. A timed chat, queue or account ban has no
// end until the player is first told (next login or Notification): then it
// runs its full length from that moment.
export const STARTS_ON_LOGIN = 'starts when the player next logs in'

export interface BanEnd {
  expiresAt: string | null
  // The length of a timed ban; null for a permanent one.
  durationMs?: number | null
}

export function startsOnLogin(ban: BanEnd): boolean {
  return ban.expiresAt === null && (ban.durationMs ?? null) !== null
}

export function banEndText(
  ban: BanEnd,
  format: (iso: string) => string
): string {
  if (ban.expiresAt) return format(ban.expiresAt)
  return startsOnLogin(ban) ? STARTS_ON_LOGIN : 'permanent'
}
