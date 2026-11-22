// The inbox: things a player's game must do once, in order. `addInboxItem` is the only
// writer. An item keeps its number and stays for the whole run, done or not.
import { changeRunPlayer } from './run_player'
import type {
	InputResult,
	MineView,
	NewInboxItem,
	PlayerId,
	State,
} from './types'

// The most items one view carries.
export const INBOX_ITEMS_PER_VIEW = 32

// The item gets the next number for that player in this run.
export function addInboxItem(
	state: State,
	player: PlayerId,
	item: NewInboxItem,
): State {
	return changeRunPlayer(state, player, (entry) => ({
		...entry,
		inbox: [...entry.inbox, { ...item, itemNumber: entry.inbox.length + 1 }],
	}))
}

// Takes the player's last-item-done number from an input header. One above the inbox is
// ignored and reported, never clamped; one below what is already known changes nothing.
export function recordLastItemDone(
	state: State,
	player: PlayerId,
	inboxDone: number,
): InputResult {
	const entry = state.run?.players[player]
	if (entry === undefined) return { state, refusals: [] }
	if (inboxDone > entry.inbox.length)
		return { state, refusals: ['bad_inbox_done'] }
	if (inboxDone <= entry.inboxDone) return { state, refusals: [] }
	return {
		state: changeRunPlayer(state, player, (own) => ({ ...own, inboxDone })),
		refusals: [],
	}
}

// What the view shows of the inbox: the first items above the last one done, oldest
// first, and the number of the newest item written (0 before a run).
export function visibleInbox(
	state: State,
	player: PlayerId,
): Pick<MineView, 'inbox' | 'inboxNewest'> {
	const entry = state.run?.players[player]
	if (entry === undefined) return { inbox: [], inboxNewest: 0 }
	return {
		inbox: entry.inbox.slice(
			entry.inboxDone,
			entry.inboxDone + INBOX_ITEMS_PER_VIEW,
		),
		inboxNewest: entry.inbox.length,
	}
}
