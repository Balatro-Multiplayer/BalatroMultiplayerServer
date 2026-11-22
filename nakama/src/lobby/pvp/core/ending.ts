// How a run ends, as the rules name it: the winners (null for a draw) and every player's
// place. The mode's win check and the waiting deaths both answer in this shape; the one
// writer of the match result is inputs/finish.ts.
import type { PlayerId, Run } from './types'

export interface Ending {
	// null: a draw.
	winners: PlayerId[] | null
	places: Run['places']
}

const everyonePlaces = (
	run: Run,
	place: (id: PlayerId) => number,
): Run['places'] => {
	const places: Run['places'] = {}
	for (const id of Object.keys(run.lives).sort()) places[id] = place(id)
	return places
}

export function winEnding(run: Run, winners: PlayerId[]): Ending {
	const sorted = [...winners].sort()
	return {
		winners: sorted,
		places: everyonePlaces(run, (id) => (sorted.includes(id) ? 1 : 2)),
	}
}

export const drawEnding = (run: Run): Ending => ({
	winners: null,
	places: everyonePlaces(run, () => 1),
})
