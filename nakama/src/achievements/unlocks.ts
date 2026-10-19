// Which avatars a player's progress has earned, and how far along each goal
// is (the avatar_catalog RPC shows it). Pure.
import { CATALOG, type CatalogEntry } from '../shared/avatars/catalog'
import type { AvatarId } from '../shared/avatars/ids'
import { isEarnedByPlay, membersOf, type Counter, type UnlockRule } from '../shared/avatars/rules'
import { isSelectable, type Holdings } from '../shared/avatars/unlocked'
import type { Progress } from './progress'

export type GoalKind = 'privilege' | 'counter' | 'deckGames' | 'allOf' | 'milestone' | 'allUnlockable' | 'reserved'

// What an avatar asks for: key names the counter, deck, collection,
// milestone, privilege or reserved mode. progress counts up to threshold.
export interface Goal {
	kind: GoalKind
	key: string
	threshold: number
	progress: number
}

export function counterValue(progress: Progress, counter: Counter): number {
	return counter === 'bestWinStreak' ? progress.winStreak.best : progress.counters[counter]
}

function covered(progress: Progress, rule: Extract<UnlockRule, { kind: 'allOf' }>): number {
	const members = membersOf(rule.collection)
	const played =
		rule.collection === 'vanillaDecks'
			? members.filter((deck) => (progress.deckGames[deck] || 0) > 0)
			: members.filter((mode) => (progress.spdrnModesPlayed as readonly string[]).indexOf(mode) !== -1)
	return played.length
}

// The avatars every allUnlockable rule asks for.
function unlockables(except: AvatarId): CatalogEntry[] {
	return CATALOG.filter((entry) => entry.id !== except && isEarnedByPlay(entry.rule))
}

function allUnlockableDone(progress: Progress, id: AvatarId, holdings: Holdings): number {
	return unlockables(id).filter((entry) => isSelectable(entry.id, holdings)).length
}

// null for a default avatar: it asks for nothing.
export function goalOf(entry: CatalogEntry, progress: Progress, holdings: Holdings): Goal | null {
	const rule = entry.rule
	switch (rule.kind) {
		case 'default':
			return null
		case 'privilege':
			return { kind: 'privilege', key: rule.privilege, threshold: 1, progress: holdings.privileges.indexOf(rule.privilege) !== -1 ? 1 : 0 }
		case 'counter':
			return { kind: 'counter', key: rule.counter, threshold: rule.threshold, progress: Math.min(counterValue(progress, rule.counter), rule.threshold) }
		case 'deckGames':
			return { kind: 'deckGames', key: rule.deck, threshold: rule.threshold, progress: Math.min(progress.deckGames[rule.deck] || 0, rule.threshold) }
		case 'allOf':
			return { kind: 'allOf', key: rule.collection, threshold: membersOf(rule.collection).length, progress: covered(progress, rule) }
		case 'milestone':
			return { kind: 'milestone', key: rule.milestone, threshold: 1, progress: progress.milestones.indexOf(rule.milestone) !== -1 ? 1 : 0 }
		case 'allUnlockable':
			return { kind: 'allUnlockable', key: 'allUnlockable', threshold: unlockables(entry.id).length, progress: allUnlockableDone(progress, entry.id, holdings) }
		case 'reserved':
			return { kind: 'reserved', key: rule.reservedFor, threshold: 1, progress: 0 }
	}
}

// Whether progress meets an earned-by-play rule (allUnlockable aside).
function meets(rule: UnlockRule, progress: Progress): boolean {
	switch (rule.kind) {
		case 'counter':
			return counterValue(progress, rule.counter) >= rule.threshold
		case 'deckGames':
			return (progress.deckGames[rule.deck] || 0) >= rule.threshold
		case 'allOf':
			return covered(progress, rule) >= membersOf(rule.collection).length
		case 'milestone':
			return progress.milestones.indexOf(rule.milestone) !== -1
		default:
			return false
	}
}

// Avatars progress earns that it hasn't recorded as unlocked yet, in
// catalog order. allUnlockable counts the ones earned here too, and an
// avatar a privilege grants counts as held for it.
export function newlyUnlocked(progress: Progress, privileges: readonly string[]): AvatarId[] {
	const fresh = CATALOG.filter((entry) => progress.unlocked.indexOf(entry.id) === -1 && meets(entry.rule, progress)).map(
		(entry) => entry.id,
	)
	const holdings: Holdings = { privileges, unlocked: progress.unlocked.concat(fresh) }
	for (const entry of CATALOG) {
		if (entry.rule.kind !== 'allUnlockable' || holdings.unlocked.indexOf(entry.id) !== -1) continue
		if (allUnlockableDone(progress, entry.id, holdings) >= unlockables(entry.id).length) fresh.push(entry.id)
	}
	return fresh
}
