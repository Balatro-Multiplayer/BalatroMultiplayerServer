// When a failed (or refused) launcher challenge becomes a service-queue item:
// while the player is ranked-queued or in a ranked game, or on the
// REPEAT_THRESHOLD-th failure of a UTC day. One item per player per day.
import type { IntegrityTrigger } from './types.js'

export const REPEAT_THRESHOLD = 3

export interface IntegrityFailureContext {
	ranked: { queued: boolean; inGame: boolean } | null
	// Failures recorded for the player today (UTC), this one included.
	failuresToday: number
}

export type IntegrityFlagDecision = { kind: 'raise'; trigger: IntegrityTrigger } | { kind: 'none' }

export function decideIntegrityFlag(context: IntegrityFailureContext): IntegrityFlagDecision {
	if (context.ranked && (context.ranked.queued || context.ranked.inGame)) return { kind: 'raise', trigger: 'ranked' }
	if (context.failuresToday >= REPEAT_THRESHOLD) return { kind: 'raise', trigger: 'repeated' }
	return { kind: 'none' }
}

// The UTC day an event falls on, as the item's source id carries it.
export function utcDayOf(at: Date): string {
	return at.toISOString().slice(0, 10)
}

export function integritySourceId(playerId: string, at: Date): string {
	return `${playerId}:${utcDayOf(at)}`
}

export function utcDayStart(at: Date): Date {
	return new Date(`${utcDayOf(at)}T00:00:00.000Z`)
}
