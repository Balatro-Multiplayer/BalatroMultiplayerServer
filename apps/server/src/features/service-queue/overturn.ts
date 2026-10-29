// Overturning a disputed result: the conflicting report's placements become
// the result. A conflict's first report is the one that agreed with the
// recorded result, so naming it changes nothing.

export interface Placement {
	playerId: string
	place: number
}

export interface ConflictReports {
	firstReporterId: string
	firstPlacements: unknown
	conflictingReporterId: string
	conflictingPlacements: unknown
}

export type OverturnPlan =
	| { ok: true; placements: Placement[] }
	| { ok: false; refusal: 'unchanged' | 'invalid_target' | 'source_missing' }

function placementsOf(value: unknown): Placement[] | null {
	if (!Array.isArray(value) || value.length < 2) return null
	const out: Placement[] = []
	for (const p of value) {
		if (!p || typeof p !== 'object') return null
		const { playerId, place } = p as { playerId?: unknown; place?: unknown }
		if (typeof playerId !== 'string' || typeof place !== 'number' || !Number.isInteger(place) || place < 1) return null
		out.push({ playerId, place })
	}
	return out.sort((a, b) => a.place - b.place)
}

export function planOverturn(conflict: ConflictReports, toReportOf: string): OverturnPlan {
	if (toReportOf === conflict.firstReporterId) return { ok: false, refusal: 'unchanged' }
	if (toReportOf !== conflict.conflictingReporterId) return { ok: false, refusal: 'invalid_target' }
	const placements = placementsOf(conflict.conflictingPlacements)
	return placements ? { ok: true, placements } : { ok: false, refusal: 'source_missing' }
}

// The result a ranked replay rates: every player but the flagged ones (as
// Nakama rates a game); a casual or private game is not rated.
export function ratedPlacements(
	placements: readonly Placement[],
	flagged: ReadonlySet<string>,
	ranked: boolean,
): (Placement & { rated?: boolean })[] {
	return placements.map((p) => (ranked ? { ...p, rated: !flagged.has(p.playerId) } : { ...p }))
}

// Whether two results put every player in the same place.
export function samePlaces(a: readonly Placement[], b: readonly Placement[]): boolean {
	if (a.length !== b.length) return false
	const places = new Map(a.map((p) => [p.playerId, p.place]))
	return b.every((p) => places.get(p.playerId) === p.place)
}

// A contest decided for a named winner: first place for them, every other
// player tied behind (a moderator names one winner, not a full order).
export function planContestOverturn(participants: readonly string[], winnerId: string): OverturnPlan {
	if (participants.length < 2) return { ok: false, refusal: 'source_missing' }
	if (!participants.includes(winnerId)) return { ok: false, refusal: 'invalid_target' }
	return {
		ok: true,
		placements: [
			{ playerId: winnerId, place: 1 },
			...participants.filter((id) => id !== winnerId).map((playerId) => ({ playerId, place: 2 })),
		],
	}
}
