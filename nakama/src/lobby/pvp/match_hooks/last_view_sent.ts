// What each player was last sent of the match, so only a view that changed goes out again.
import type { PvpViewMessage } from '../../protocol'
import { same } from '../core/same'
import type { Milliseconds, PlayerId, State } from '../core/types'
import { type ViewFacts, view } from '../core/view'

// The last view sent to each player.
export type LastViewSent = { [player: PlayerId]: PvpViewMessage }

// The views that differ from what was last sent (the server time does not count), and the
// record of what is sent now. An empty record sends every player their view.
export function viewsToSend(
	sent: LastViewSent,
	after: State,
	players: PlayerId[],
	now: Milliseconds,
	facts: ViewFacts,
): { views: { player: PlayerId; view: PvpViewMessage }[]; sent: LastViewSent } {
	return changedViews(sent, players, (player) => view(after, player, now, facts))
}

// The same for any view: `viewOf` gives a player's view now, null for a player with none.
export function changedViews(
	sent: LastViewSent,
	players: PlayerId[],
	viewOf: (player: PlayerId) => PvpViewMessage | null,
): { views: { player: PlayerId; view: PvpViewMessage }[]; sent: LastViewSent } {
	const views: { player: PlayerId; view: PvpViewMessage }[] = []
	// Only the lobby's current players are remembered.
	const record: LastViewSent = Object.fromEntries(
		Object.entries(sent).filter(([player]) => players.includes(player)),
	)
	for (const player of players) {
		const mine = viewOf(player)
		if (mine === null) continue
		const before = sent[player]
		if (
			before !== undefined &&
			same({ ...before, serverTime: 0 }, { ...mine, serverTime: 0 })
		)
			continue
		views.push({ player, view: mine })
		record[player] = mine
	}
	return { views, sent: record }
}
