// Which avatars a player may pick: the defaults, the ones their privileges
// grant, and the ones they have earned (achievements/progress.ts keeps the
// earned list). Lock enforcement does not depend on the achievementsEnabled
// switch; that switch only stops new avatars being earned.
import { CATALOG, entryOf, type CatalogEntry } from './catalog'
import { DEFAULT_AVATAR, isAvatarId, type AvatarId } from './ids'

export interface Holdings {
	privileges: readonly string[]
	// Avatars the player has earned.
	unlocked: readonly string[]
}

export const NO_HOLDINGS: Holdings = { privileges: [], unlocked: [] }

function grantedByPrivilege(entry: CatalogEntry, privileges: readonly string[]): boolean {
	if (entry.rule.kind === 'privilege' && privileges.indexOf(entry.rule.privilege) !== -1) return true
	return entry.alsoGrantedBy !== undefined && privileges.indexOf(entry.alsoGrantedBy) !== -1
}

export function isSelectable(id: unknown, holdings: Holdings): id is AvatarId {
	if (!isAvatarId(id)) return false
	const entry = entryOf(id)
	if (entry.rule.kind === 'default') return true
	if (grantedByPrivilege(entry, holdings.privileges)) return true
	if (entry.rule.kind === 'reserved' || entry.rule.kind === 'privilege') return false
	return holdings.unlocked.indexOf(id) !== -1
}

// id when the player may show it, the default avatar otherwise.
export function selectableOrDefault(id: unknown, holdings: Holdings): AvatarId {
	return isSelectable(id, holdings) ? id : DEFAULT_AVATAR
}

export function selectableAvatars(holdings: Holdings): AvatarId[] {
	return CATALOG.filter((entry) => isSelectable(entry.id, holdings)).map((entry) => entry.id)
}

// The client's privilege table: the avatars the player's privileges grant.
export function privilegeTable(privileges: readonly string[]): { jokers?: AvatarId[] } {
	const jokers = CATALOG.filter((entry) => grantedByPrivilege(entry, privileges)).map((entry) => entry.id)
	return jokers.length > 0 ? { jokers } : {}
}
