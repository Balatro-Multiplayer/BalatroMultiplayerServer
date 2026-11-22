import { apply } from '../core/apply'
import type {
	EndedBy,
	Milliseconds,
	PlayerId,
	PvpBlindPlayer,
	Run,
	State,
} from '../core/types'
// Test support: send one input the way a client does; the PvP blind opens and stale timers go,
// the match is not decided (a test calls decideMatch when it wants that).
import { dropPlayer } from '../inputs/finish'
import { openPvpBlindIfReady } from '../inputs/pvp_blind'
import { handsLeftOf, scoreOf } from '../rules/pvp_blind_rules'

export const BLIND = '2:Boss'

// A player forfeits or leaves the way the shell handles it: then the Boss that was only
// waiting on them opens.
export const drop = (
	state: State,
	player: PlayerId,
	how: 'forfeit' | 'left',
	now: Milliseconds = 0,
): State => openPvpBlindIfReady(dropPlayer(state, player, how, now), now)

// The body is the kind's own fields; the header is filled in. The input is the next one after
// `last` (default: the body's messageNumber minus one, else the first).
export function send(
	state: State,
	player: PlayerId,
	body: { [field: string]: unknown },
	now: Milliseconds = 0,
	last?: number,
): { state: State; refusals: string[]; lastNumber: number } {
	const number = typeof body.messageNumber === 'number' ? body.messageNumber : 1
	const taken = apply(
		state,
		player,
		{
			messageNumber: 1,
			inboxDone: 0,
			runId: body.kind === 'team' ? null : (state.run?.id ?? null),
			...body,
		},
		last ?? number - 1,
		now,
	)
	return taken
}

export const ready = (
	state: State,
	player: PlayerId,
	value = true,
	blindKey = BLIND,
	now: Milliseconds = 0,
): { state: State; refusals: string[] } =>
	send(state, player, { kind: 'ready', ready: value, blindKey }, now)

export function runOf(state: State): Run {
	if (state.run === null) throw new Error('no run')
	return state.run
}

// A player's entry in the PvP blind being played.
export function entryOf(state: State, player: PlayerId): PvpBlindPlayer {
	const own = runOf(state).currentPvpBlind?.players[player]
	if (own === undefined) throw new Error('not in the PvP blind')
	return own
}

export const endedByOf = (state: State, player: PlayerId): EndedBy | null => {
	const own = entryOf(state, player)
	return own.stage === 'done' ? own.endedBy : null
}
export const scoreInPvpBlind = (
	state: State,
	player: PlayerId,
): string | null => scoreOf(entryOf(state, player))
export const handsLeftInPvpBlind = (
	state: State,
	player: PlayerId,
): number | null => handsLeftOf(entryOf(state, player))
