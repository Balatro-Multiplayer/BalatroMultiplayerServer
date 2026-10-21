// Claiming an item: a moderator who opens it holds it for CLAIM_TTL_MS, so
// two don't work the same one. Pure decisions over the row's claim columns;
// the gateway applies them with a conditional update.

export const CLAIM_TTL_MS = 15 * 60 * 1000

export interface Claim {
	claimedBy: string | null
	claimedUntil: Date | null
}

export function activeClaimant(claim: Claim, now: Date): string | null {
	return claim.claimedBy && claim.claimedUntil && claim.claimedUntil > now ? claim.claimedBy : null
}

// Whether actor (a 'role:playerId' string) is blocked by someone else's claim.
// Claims are by player: the same player under either role holds it.
export function heldByOther(claim: Claim, actorPlayerId: string, now: Date): string | null {
	const holder = activeClaimant(claim, now)
	if (!holder) return null
	return holder.slice(holder.indexOf(':') + 1) === actorPlayerId ? null : holder
}

export type ClaimDecision =
	| { kind: 'claim'; until: Date }
	| { kind: 'held'; claimedBy: string; claimedUntil: Date }
	| { kind: 'closed' }

// Claiming (or refreshing one's own claim on) an open item.
export function decideClaim(
	item: Claim & { status: string },
	actorPlayerId: string,
	now: Date,
): ClaimDecision {
	if (item.status !== 'open') return { kind: 'closed' }
	const other = heldByOther(item, actorPlayerId, now)
	if (other) return { kind: 'held', claimedBy: other, claimedUntil: item.claimedUntil as Date }
	return { kind: 'claim', until: new Date(now.getTime() + CLAIM_TTL_MS) }
}

export type ReleaseDecision = { kind: 'release' } | { kind: 'held'; claimedBy: string } | { kind: 'unclaimed' }

// Releasing: one's own claim, or anyone's for an admin forcing it.
export function decideRelease(item: Claim, actorPlayerId: string, force: boolean, now: Date): ReleaseDecision {
	const holder = activeClaimant(item, now)
	if (!holder) return { kind: 'unclaimed' }
	if (!force && heldByOther(item, actorPlayerId, now)) return { kind: 'held', claimedBy: holder }
	return { kind: 'release' }
}
