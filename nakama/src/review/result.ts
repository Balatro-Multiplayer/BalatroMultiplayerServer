// A moderator replacing a finished run's recorded result (the service
// queue's overturn). Pure: the new record and each participant's my_runs
// place. Ratings are not touched here -- the API rebuilds the rating board
// and pushes it with admin_ratings_set.
import type { Placement, RunRecord } from '../lobby/protocol'

export interface ResultPlacement {
	playerId: string
	place: number
}

export type OverturnRefusal =
	| { kind: 'not_a_placement_list' }
	| { kind: 'players_differ' }
	| { kind: 'unchanged' }

export type Overturn =
	| { ok: true; run: RunRecord; places: { [userId: string]: number } }
	| { ok: false; refusal: OverturnRefusal }

export function parseResultPlacements(value: unknown): ResultPlacement[] | null {
	if (!Array.isArray(value) || value.length === 0) return null
	const out: ResultPlacement[] = []
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) return null
		const { playerId, place } = entry as { playerId?: unknown; place?: unknown }
		if (typeof playerId !== 'string' || typeof place !== 'number' || !Number.isInteger(place) || place < 1)
			return null
		out.push({ playerId, place })
	}
	return out
}

function sameIds(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	const sorted = (ids: string[]) => ids.slice().sort().join(',')
	return sorted(a) === sorted(b)
}

function placesKey(placements: ResultPlacement[]): string {
	return placements
		.map((p) => `${p.playerId}=${p.place}`)
		.sort()
		.join(',')
}

// The run with `placements` as its result. The new result must place exactly
// the players the old one did; each keeps their reported performance/metric.
export function overturnRun(run: RunRecord, placements: ResultPlacement[], now: number): Overturn {
	if (!sameIds(run.placements.map((p) => p.playerId), placements.map((p) => p.playerId)))
		return { ok: false, refusal: { kind: 'players_differ' } }
	if (placesKey(run.placements) === placesKey(placements)) return { ok: false, refusal: { kind: 'unchanged' } }
	const previousBy: { [userId: string]: Placement } = {}
	for (const p of run.placements) previousBy[p.playerId] = p
	const next: Placement[] = placements
		.slice()
		.sort((a, b) => a.place - b.place)
		.map((p) => ({ ...previousBy[p.playerId], playerId: p.playerId, place: p.place }))
	const places: { [userId: string]: number } = {}
	for (const p of next) places[p.playerId] = p.place
	return {
		ok: true,
		run: {
			...run,
			placements: next,
			overturned: { at: now, previous: run.overturned ? run.overturned.previous : run.placements },
		},
		places,
	}
}
