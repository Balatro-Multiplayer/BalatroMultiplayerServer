// The skip time and the Ante bank, as pure rules.
// A client reports its skip total and what it spends;
// the server derives each player's Ante bank from those actions and the settings.
// Plain data in, plain data out: no clock, no lobby, no state but the entries.
import type { PvpMode } from './settings'

// A player's skip actions of the run. An absent entry is a player who has not skipped:
// a run starts at 0 skips, nothing spent.
interface SkipEntry {
	// The run total last reported (G.GAME.skips); a run starts at 0.
	skips: number
	// `skips` as of the last PvP blind open or close.
	skipsAtPvp: number | null
	// The player faced at that point (the lead is counted against them).
	facing: string | null
	// Ante bank used since that point (the time their own deadline ran).
	spentMilliseconds: number
}

// userId -> the player's skip actions; a player with no entry has not skipped.
export type SkipEntries = { [userId: string]: SkipEntry }

const NO_SKIPS: SkipEntry = {
	skips: 0,
	skipsAtPvp: null,
	facing: null,
	spentMilliseconds: 0,
}

export function skipEntryOf(entries: SkipEntries, id: string): SkipEntry {
	return entries[id] ?? NO_SKIPS
}

// A reported run total: a lower one is stale (the caller refuses it), an equal one
// changes nothing. The same map when nothing changes.
export function skipsReported(
	entries: SkipEntries,
	id: string,
	skips: number,
): SkipEntries {
	const entry = skipEntryOf(entries, id)
	if (entry.skips === skips) return entries
	return { ...entries, [id]: { ...entry, skips } }
}

// The skips a player made since the last PvP blind closed; before any has closed, since the
// run began. A player who has reported none has made none.
export function skipsSincePvp(entry: SkipEntry): number {
	return Math.max(0, entry.skips - (entry.skipsAtPvp ?? 0))
}

// The Ante bank the skip time gives: the base plus the increment per skip. The 'lead' rule
// counts only the skips over the opponent's, so an even race adds nothing;
// the 'own' rule (Major League) counts every own skip. No increment, no change.
export function anteBankOf(
	baseMilliseconds: number,
	incrementMilliseconds: number | null,
	rule: 'lead' | 'own',
	own: SkipEntry,
	opponent: SkipEntry | null,
): number {
	if (incrementMilliseconds === null) return baseMilliseconds
	const mine = skipsSincePvp(own)
	const counted =
		rule === 'own'
			? mine
			: Math.max(0, mine - (opponent === null ? 0 : skipsSincePvp(opponent)))
	return baseMilliseconds + counted * incrementMilliseconds
}

// Every player's skips as of this PvP blind close: the next count starts from here.
export function skipsAtPvpClose(
	entries: SkipEntries,
	players: string[],
): SkipEntries {
	const next: SkipEntries = { ...entries }
	for (const id of players) {
		const entry = skipEntryOf(entries, id)
		next[id] = { ...entry, skipsAtPvp: entry.skips }
	}
	return next
}
