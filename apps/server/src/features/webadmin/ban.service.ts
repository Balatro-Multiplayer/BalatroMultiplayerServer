import {
	type BanRecord,
	type BanType,
	insertBan,
} from '../../infrastructure/gateways/ban.gateway.js'
import { banInNakama } from '../../infrastructure/nakama/moderation-sync.js'

export interface IssueBanParams {
	playerId: string
	banType: BanType
	expiresAt: Date | null
	reason: string
	issuedBy: string
}

/**
 * Extracted from the original POST /players/:id/bans handler so the
 * service-queue "Ban" action (service-queue-actions.ts) can reuse the exact
 * same side-effect sequence instead of duplicating it.
 *
 * §21.3: account and queue bans take effect immediately. Postgres keeps the
 * ban history; Nakama enforces it at once (nakama/src/admin.ts): an account
 * ban closes the player's session and forfeits their match, a queue ban
 * pulls them out of matchmaking. A player Nakama doesn't know yet is caught
 * by the player sync at their next login.
 */
export async function issueBan(params: IssueBanParams): Promise<BanRecord> {
	const ban = await insertBan({
		playerId: params.playerId,
		banType: params.banType,
		expiresAt: params.expiresAt,
		issuedBy: params.issuedBy,
		reason: params.reason,
	})

	await banInNakama(ban).catch((e) =>
		console.error('[ban.service] Nakama ban failed:', e),
	)

	return ban
}
