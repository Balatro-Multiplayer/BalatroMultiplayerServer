import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { chatLogs } from '../db/schema.js'

// Account-deletion side effect: chat logs aren't deleted (moderators may still
// need them for the remainder of their normal 90-day retention window), but
// the sender is no longer identifiable via playerId once their account is
// gone — moderationId (the hashed Steam ID) still carries whatever
// moderation-relevant linkage is needed.
export async function pseudonymizeChatLogsForPlayer(
	playerId: string,
): Promise<void> {
	await db
		.update(chatLogs)
		.set({ playerId: `deleted_user_${playerId}` })
		.where(eq(chatLogs.playerId, playerId))
}
