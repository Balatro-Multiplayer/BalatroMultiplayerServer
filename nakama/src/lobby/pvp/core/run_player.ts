import type { PlayerId, Run, RunPlayer, State } from './types'

// The state with one player's entry in the run changed. A player who is not in the run
// is a bug in the caller, never an input from a client, so it throws.
export function changeRunPlayer(
	state: State,
	player: PlayerId,
	change: (entry: RunPlayer) => RunPlayer,
): State {
	const run: Run | null = state.run
	const entry = run?.players[player]
	if (run === null || entry === undefined)
		throw new Error(`player ${player} is not in the run`)
	return {
		...state,
		run: { ...run, players: { ...run.players, [player]: change(entry) } },
	}
}
