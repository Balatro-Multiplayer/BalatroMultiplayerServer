import { compareBlindScore } from '../core/score'
// The duel: exactly two players. The roster and the win check are the shared ones
// (modes/common.ts); this file adds the two-player PvP blind resolution and the opponent view.
//
// - Blind results are not part of what a mode reads, so a waiting death is settled by the
//   caller, and `decideMatch` holds the result while one waits.
// - `losersOf` only names the losers; lives are the ledger's.
import type { PlayerId, PvpBlind, Run } from '../core/types'
import {
	aliveInPvpBlind,
	hasNotReported,
	lastStandingBase,
	scoreOf,
} from './common'
import type { Mode, TargetsShown } from './types'

// The PvP blind ends when the trailing player has no hands left, or both
// have none. The higher score wins; an exact tie names no loser.
export function duelLosers(
	run: Run,
	currentPvpBlind: PvpBlind,
): PlayerId[] | null {
	const alive = aliveInPvpBlind(run, currentPvpBlind)
	if (alive.length !== 2) return null
	const [firstId, secondId] = alive
	const first = currentPvpBlind.players[firstId]
	const second = currentPvpBlind.players[secondId]
	// Nothing to rank until both have started the blind, unless the server
	// ended a player's hands (a Ready left the blind without one).
	if (
		hasNotReported(currentPvpBlind, firstId) ||
		hasNotReported(currentPvpBlind, secondId)
	)
		return null
	const order = compareBlindScore(
		scoreOf(currentPvpBlind, firstId),
		scoreOf(currentPvpBlind, secondId),
	)
	const firstScoreLower = order === -1
	const secondScoreLower = order === 1
	const firstOutOfHands = first.stage === 'done'
	const secondOutOfHands = second.stage === 'done'
	const trigger =
		(firstOutOfHands && firstScoreLower) ||
		(secondOutOfHands && secondScoreLower) ||
		(firstOutOfHands && secondOutOfHands)
	if (!trigger) return null
	return order === 0 ? [] : [firstScoreLower ? firstId : secondId]
}

// The duel opponent of each of `ids` (null with none).
export function duelOpponents(ids: PlayerId[]): TargetsShown['opponents'] {
	const out: TargetsShown['opponents'] = {}
	for (const id of ids) out[id] = ids.find((other) => other !== id) ?? null
	return out
}

export const duelMode: Mode = {
	name: 'duel',
	// The last life lost on a normal blind waits on the opponent.
	deathWaitsOn: 'opponent',
	...lastStandingBase,
	losersOf: duelLosers,
	view: (run) => ({ opponents: duelOpponents(Object.keys(run.lives).sort()) }),
}
