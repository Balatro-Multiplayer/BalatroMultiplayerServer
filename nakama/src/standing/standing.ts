// An account's standing: what it may queue for. Pure.
//  - verified: the BET launcher vouched for the client (integrity.ts); may
//    queue anything, whatever its mods.
//  - valid: this session's mod report lists only allowed mods (any mods off
//    the Official server); casual only.
//  - none: no report this session, or a mod that isn't allowed.
import { disallowedMods, type ModReport } from './mod_report'

export type AccountStanding = 'verified' | 'valid' | 'none'
export type StandingReason = 'unreported' | 'mods_not_allowed'
export type QueueKind = 'ranked' | 'casual'
// What a matchmade game asks of a returning player (lobby/match.ts).
export type RequiredStanding = 'valid' | 'verified'

export interface StandingInput {
	verified: boolean
	report: ModReport | null
	// 'any' off the Official server: every mod is allowed there.
	allowedIds: string[] | 'any'
}

export interface StandingResult {
	standing: AccountStanding
	// The reported mods that aren't allowed: set only when they are the reason.
	disallowed: string[]
	reason: StandingReason | null
}

const VERIFIED: StandingResult = { standing: 'verified', disallowed: [], reason: null }
const VALID: StandingResult = { standing: 'valid', disallowed: [], reason: null }

export function standingOf(input: StandingInput): StandingResult {
	if (input.verified) return VERIFIED
	if (!input.report) return { standing: 'none', disallowed: [], reason: 'unreported' }
	if (input.allowedIds === 'any') return VALID
	const disallowed = disallowedMods(input.report.mods, input.allowedIds)
	if (disallowed.length > 0) return { standing: 'none', disallowed, reason: 'mods_not_allowed' }
	return VALID
}

export function queueAllowed(standing: AccountStanding, kind: QueueKind): boolean {
	if (kind === 'ranked') return standing === 'verified'
	return standing !== 'none'
}

const RANK: { [standing in AccountStanding]: number } = { none: 0, valid: 1, verified: 2 }

export function meetsRequirement(standing: AccountStanding, required: RequiredStanding): boolean {
	return RANK[standing] >= RANK[required]
}

// The bar a matchmade game sets when it is planned: verified for a ranked
// game while ranked needs the launcher, valid otherwise.
export function requiredStandingFor(ranked: boolean, integrityEnforced: boolean): RequiredStanding {
	return ranked && integrityEnforced ? 'verified' : 'valid'
}
