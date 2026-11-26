// The instant queue ranges: per ranked queue (mod and game mode), the rating
// at or above which (floor) and at or below which (ceiling) a player queues
// among everyone in that range at once, plus how long such a player waits
// before the range opens up (multiplier of the time the normal window would
// need to reach the range's edge). Pure: the route and the gateway use it.

export interface InstantRange {
	// The queue's ranges apply only while on; the values are kept when off.
	enabled: boolean
	// null: no range on that side.
	floor: number | null
	ceiling: number | null
	floorMultiplier: number
	ceilingMultiplier: number
}

export const MAX_RANGE_RATING = 10000
export const MIN_MULTIPLIER = 0.1
export const MAX_MULTIPLIER = 10

export const EMPTY_RANGE: InstantRange = {
	enabled: false,
	floor: null,
	ceiling: null,
	floorMultiplier: 1,
	ceilingMultiplier: 1,
}

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export const isQueueName = (value: unknown): value is string =>
	typeof value === 'string' && NAME_PATTERN.test(value)

// The key Nakama's config holds a queue's range under.
export const rangeKey = (modId: string, gameMode: string): string =>
	`${modId}:${gameMode}`

export const isSet = (range: InstantRange): boolean =>
	range.floor !== null || range.ceiling !== null

// A range that Nakama and the mod act on: on, with an edge.
export const isActive = (range: InstantRange): boolean =>
	range.enabled && isSet(range)

function parseEdge(
	value: unknown,
	name: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
	if (value === null || value === undefined) return { ok: true, value: null }
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > MAX_RANGE_RATING
	)
		return {
			ok: false,
			message: `${name} must be a whole rating from 0 to ${MAX_RANGE_RATING}, or empty`,
		}
	return { ok: true, value }
}

function parseMultiplier(
	value: unknown,
	name: string,
): { ok: true; value: number } | { ok: false; message: string } {
	if (value === null || value === undefined) return { ok: true, value: 1 }
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value < MIN_MULTIPLIER ||
		value > MAX_MULTIPLIER
	)
		return {
			ok: false,
			message: `${name} must be from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}`,
		}
	return { ok: true, value: Math.round(value * 100) / 100 }
}

export type RangeCheck =
	| { ok: true; range: InstantRange }
	| { ok: false; message: string }

// A request body as a range: whole-number edges (or null), multipliers, and a
// ceiling that sits below the floor.
export function parseRange(body: unknown): RangeCheck {
	if (typeof body !== 'object' || body === null || Array.isArray(body))
		return { ok: false, message: 'Body must be an object' }
	const b = body as Record<string, unknown>
	const floor = parseEdge(b.floor, 'floor')
	if (!floor.ok) return floor
	const ceiling = parseEdge(b.ceiling, 'ceiling')
	if (!ceiling.ok) return ceiling
	const floorMultiplier = parseMultiplier(b.floorMultiplier, 'floorMultiplier')
	if (!floorMultiplier.ok) return floorMultiplier
	const ceilingMultiplier = parseMultiplier(
		b.ceilingMultiplier,
		'ceilingMultiplier',
	)
	if (!ceilingMultiplier.ok) return ceilingMultiplier
	if (b.enabled !== undefined && typeof b.enabled !== 'boolean')
		return { ok: false, message: 'enabled must be true or false' }
	if (
		floor.value !== null &&
		ceiling.value !== null &&
		ceiling.value >= floor.value
	)
		return { ok: false, message: 'The ceiling must be below the floor' }
	return {
		ok: true,
		range: {
			enabled: b.enabled === true,
			floor: floor.value,
			ceiling: ceiling.value,
			floorMultiplier: floorMultiplier.value,
			ceilingMultiplier: ceilingMultiplier.value,
		},
	}
}
