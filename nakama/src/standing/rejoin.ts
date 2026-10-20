// Taking a seat in a matchmade game needs the standing it was queued with
// (Lobby.requiredStanding), so nobody queues valid, relaunches with other
// mods and comes back. Pure. The refusal travels as a match join's
// rejectMessage: REJOIN_REFUSED_PREFIX then the JSON of a RejoinRefusalView.
import { meetsRequirement, type RequiredStanding, type StandingResult } from './standing'

export type RejoinRefusal =
	| { reason: 'mods_not_allowed'; mods: string[] }
	| { reason: 'mods_unreported' }
	// A ranked game needs a launcher verdict, which hasn't landed (yet).
	| { reason: 'verification_pending' }

export const REJOIN_REFUSED_PREFIX = 'standing_refused:'

export function rejoinRefusal(required: RequiredStanding | undefined, result: StandingResult): RejoinRefusal | null {
	if (!required || meetsRequirement(result.standing, required)) return null
	if (required === 'verified') return { reason: 'verification_pending' }
	return result.reason === 'mods_not_allowed'
		? { reason: 'mods_not_allowed', mods: result.disallowed }
		: { reason: 'mods_unreported' }
}

function messageOf(refusal: RejoinRefusal): string {
	switch (refusal.reason) {
		case 'mods_not_allowed':
			return "These mods aren't allowed in this game: " + refusal.mods.join(', ')
		case 'mods_unreported':
			return "Your game hasn't reported its mods yet. Try again in a moment."
		case 'verification_pending':
			return 'Launcher verification is still pending. Try again in a moment.'
	}
}

export interface RejoinRefusalView {
	reason: RejoinRefusal['reason']
	mods: string[]
	message: string
}

export function rejoinRejectMessage(refusal: RejoinRefusal): string {
	const view: RejoinRefusalView = {
		reason: refusal.reason,
		mods: refusal.reason === 'mods_not_allowed' ? refusal.mods : [],
		message: messageOf(refusal),
	}
	return REJOIN_REFUSED_PREFIX + JSON.stringify(view)
}
