import type { Privilege } from '@bmp/types'
import type { Player } from './types'

export function hasPrivilege(player: Player | null, priv: Privilege): boolean {
  return player?.privileges?.includes(priv) ?? false
}

export function isAdmin(player: Player | null): boolean {
  return hasPrivilege(player, 'admin')
}

// The privilege that edits the instant queue ranges without being staff.
export const INSTANT_QUEUE_PRIVILEGE = 'instaqueue'

// Admins, and anyone holding the 'instaqueue' privilege.
export function canEditInstantQueue(player: Player | null): boolean {
  return isAdmin(player) || hasPrivilege(player, INSTANT_QUEUE_PRIVILEGE)
}

export function isModerator(player: Player | null): boolean {
  return hasPrivilege(player, 'moderator') || hasPrivilege(player, 'admin')
}
