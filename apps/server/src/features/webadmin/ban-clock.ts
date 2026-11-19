// A timed chat, queue or account ban runs from the first time the player is
// told, not from when staff issue it. Postgres keeps the length (durationMs)
// with no end; Nakama starts the clock (nakama/src/moderation/enforce.ts
// startPendingBans) and the mirror records the end (expiresAt). Until then the
// ban is in force, like a permanent one.
import type { BanType } from '../../infrastructure/gateways/ban.gateway.js'

const MINUTE_MS = 60 * 1000

export interface BanClock {
	expiresAt: Date | null
	durationMs: number | null
}

// The stored end and length for a ban issued at `now` that would end at
// `expiresAt` (null: permanent).
export function clockedBan(banType: BanType, expiresAt: Date | null, now: Date): BanClock {
	if (expiresAt === null || banType === 'username') return { expiresAt, durationMs: null }
	const length = Math.max(MINUTE_MS, Math.round((expiresAt.getTime() - now.getTime()) / MINUTE_MS) * MINUTE_MS)
	return { expiresAt: null, durationMs: length }
}

// A timed ban whose clock has not started: the player has not been told yet.
export function banStartsOnLogin(ban: { expiresAt: Date | null; durationMs: number | null }): boolean {
	return ban.expiresAt === null && ban.durationMs !== null
}
