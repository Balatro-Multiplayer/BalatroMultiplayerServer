import { sql } from 'drizzle-orm'
import type { DbTransaction } from './executor.js'

// A void's board rebuild and a season replay wipe a season's rating rows and
// write them again ('rewrite': one at a time, nothing else writing). Every
// other rating write (the mirror, staff match edits) takes it 'write': many at
// once, but not during a rewrite. Without it a rewrite's wipe can't see rows
// written while it runs: a second rewrite, or a player's first row, gets every
// match replayed on top of it (double counts) or fails on a duplicate key, and
// an edit to a row the wipe deleted changes nothing. Take it as the
// transaction's first statement, before any row lock.
export async function lockSeasonRatings(
	tx: DbTransaction,
	season: number,
	mode: 'rewrite' | 'write',
): Promise<void> {
	const key = sql`hashtext(${`season-ratings:${season}`})`
	await tx.execute(
		mode === 'rewrite'
			? sql`SELECT pg_advisory_xact_lock(${key})`
			: sql`SELECT pg_advisory_xact_lock_shared(${key})`,
	)
}
