// The ranked matchmaker ticket the game mod builds, ported from the mod's
// api/matchmaking/api.lua (BalatroMultiplayerAPI): the normal window, the
// instant queue ranges, and the query a ticket sends. The end-to-end tests
// queue with these tickets, so they test the server with what a real client
// asks for. window.test.ts holds the same table of values as the mod's
// tests/instant_queue_test.lua; change one, change the other.

export const SPREAD_INITIAL = 150
export const SPREAD_RATE = 50
export const SPREAD_SECS = 30
export const SPREAD_CAP = 600
export const EXTRA_CAP = SPREAD_CAP - SPREAD_INITIAL

// The answer of the queue_ranges RPC.
export interface Ranges {
	floor: number | null
	ceiling: number | null
	floorMultiplier: number
	ceilingMultiplier: number
}

export const NO_RANGES: Ranges = { floor: null, ceiling: null, floorMultiplier: 1, ceilingMultiplier: 1 }

// The normal window after `wait` seconds in the queue.
export function rankedSpread(wait: number): number {
	const steps = Math.floor(Math.max(0, wait) / SPREAD_SECS)
	return Math.min(SPREAD_INITIAL + steps * SPREAD_RATE, SPREAD_CAP)
}

// Seconds the normal window takes to span `gap` rating points.
export function secsToSpan(gap: number): number {
	const reach = Math.min(Math.max(gap, 0), SPREAD_CAP)
	const steps = Math.max(0, Math.ceil((reach - SPREAD_INITIAL) / SPREAD_RATE))
	return steps * SPREAD_SECS
}

export interface Side {
	side: 'upper' | 'lower'
	edge: number
	gap: number
	multiplier: number
}

export function instantSide(rating: number, ranges: Ranges | null): Side | null {
	if (!ranges) return null
	if (typeof ranges.floor === 'number' && rating >= ranges.floor)
		return { side: 'upper', edge: ranges.floor, gap: rating - ranges.floor, multiplier: Math.max(0.1, ranges.floorMultiplier) }
	if (typeof ranges.ceiling === 'number' && rating <= ranges.ceiling)
		return {
			side: 'lower',
			edge: ranges.ceiling,
			gap: ranges.ceiling - rating,
			multiplier: Math.max(0.1, ranges.ceilingMultiplier),
		}
	return null
}

// The second the player's instant range opens up; null for a rating in none.
export function instantOpenAt(rating: number, ranges: Ranges | null): number | null {
	const s = instantSide(rating, ranges)
	return s ? secsToSpan(s.gap) * s.multiplier : null
}

// The rating bounds of a ticket after `wait` seconds; null is no bound.
export function rankedWindow(rating: number, wait: number, ranges: Ranges | null): { lo: number | null; hi: number | null } {
	const w = Math.max(0, wait)
	const spread = rankedSpread(w)
	const lo = rating - spread
	const hi = rating + spread
	const s = instantSide(rating, ranges)
	if (!s) return { lo, hi }
	const openAt = secsToSpan(s.gap) * s.multiplier
	let extra = 0
	if (w >= openAt) {
		const steps = Math.floor((w - openAt) / SPREAD_SECS)
		extra = Math.min(steps * SPREAD_RATE, EXTRA_CAP)
	}
	if (s.side === 'upper') return w < openAt ? { lo: s.edge, hi: null } : { lo: Math.min(lo, s.edge - extra), hi: null }
	return w < openAt ? { lo: null, hi: s.edge } : { lo: null, hi: Math.max(hi, s.edge + extra) }
}

export const MOD_ID = 'MultiplayerPvP'
export const MODE = 'pvp_ranked_expanded'

export interface Ticket {
	query: string
	stringProperties: { [key: string]: string }
	numericProperties: { [key: string]: number }
}

// The ticket of a ranked player rated `rating` who has waited `wait` seconds,
// as the mod's _nakama_ticket builds it.
export function rankedTicket(rating: number, wait: number, ranges: Ranges | null): Ticket {
	const { lo, hi } = rankedWindow(rating, wait, ranges)
	let query = `+properties.modId:${MOD_ID} +properties.mode:${MODE} +properties.kind:ranked`
	if (lo !== null) query += ` +properties.rating:>=${Math.floor(lo)}`
	if (hi !== null) query += ` +properties.rating:<=${Math.ceil(hi)}`
	return {
		query,
		stringProperties: { modId: MOD_ID, mode: MODE, kind: 'ranked' },
		numericProperties: { rating },
	}
}
