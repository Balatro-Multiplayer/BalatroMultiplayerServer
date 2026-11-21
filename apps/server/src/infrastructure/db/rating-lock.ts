import { sql } from 'drizzle-orm'
import type { DbTransaction } from './executor.js'

// One rewrite of a season's ratings at a time. A void's board rebuild and a
// season replay both wipe rows and write them again; when two overlap, the
// second wipe can't see the rows the first one wrote, so it replays every
// match on top of them (double counts) or fails on a duplicate key. Take it
// as the transaction's first statement.
export async function lockSeasonRatings(
	tx: DbTransaction,
	season: number,
): Promise<void> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtext(${`season-ratings:${season}`}))`,
	)
}
