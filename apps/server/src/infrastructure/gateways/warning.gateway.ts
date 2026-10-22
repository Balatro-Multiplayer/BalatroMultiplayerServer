import { desc, eq } from 'drizzle-orm'
import type { DbExecutor } from '../db/executor.js'
import { db } from '../db/index.js'
import { playerWarnings } from '../db/schema.js'

// A moderator's warning (the service queue's warn action). Warnings never
// expire; they stay on the player's subject card.
export type WarningRecord = typeof playerWarnings.$inferSelect

export async function insertWarning(
	exec: DbExecutor,
	data: { playerId: string; itemId: number | null; message: string; issuedBy: string },
): Promise<WarningRecord> {
	const [row] = await exec.insert(playerWarnings).values(data).returning()
	return row!
}

export async function listWarnings(playerId: string, limit = 50): Promise<WarningRecord[]> {
	return db
		.select()
		.from(playerWarnings)
		.where(eq(playerWarnings.playerId, playerId))
		.orderBy(desc(playerWarnings.issuedAt))
		.limit(limit)
}
