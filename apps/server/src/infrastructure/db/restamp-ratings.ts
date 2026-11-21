import { and, eq, or, sql } from 'drizzle-orm'
import type { DbTransaction } from './executor.js'
import { matchmakingRatings } from './schema.js'

export type RatingKey = {
	playerId: string
	modId: string
	gameMode: string
	season: number
}

// Stamps these rating rows with the real clock. Call it as the transaction's
// last statement. The Discord bot's change feed reads rows written since its
// cursor, and a stamp taken before a lock wait can commit behind that cursor:
// an insert works out its VALUES before it waits on a conflicting row.
export async function restampRatings(
	tx: DbTransaction,
	keys: RatingKey[],
): Promise<void> {
	if (keys.length === 0) return
	await tx
		.update(matchmakingRatings)
		.set({ updatedAt: sql`clock_timestamp()` })
		.where(
			or(
				...keys.map((k) =>
					and(
						eq(matchmakingRatings.playerId, k.playerId),
						eq(matchmakingRatings.modId, k.modId),
						eq(matchmakingRatings.gameMode, k.gameMode),
						eq(matchmakingRatings.season, k.season),
					),
				),
			),
		)
}
