// Picks the mode a game plays. The modes fill in the rules, not this table.
import type { PvpMode } from '../rules/settings'
import type { Run } from '../core/types'
import { aliveIds } from './common'
import { duelLosers, duelMode, duelOpponents } from './duel'
import { manhuntMode } from './manhunt'
import { nemesisMode } from './nemesis'
import { royaleMode } from './royale'
import { teamsMode } from './teams'
import type { Mode } from './types'

export type { Mode, ModeName } from './types'

// The PvP blind rules of the last two: a game that started with 3+ players keeps its own
// death, hands and win rules but plays the 1v1 PvP blind and targets once exactly two
// started players are still in the lobby. A player who is out of lives but has not left counts.
const finalTwo = (mode: Mode): Mode => ({
	...mode,
	losersOf: duelLosers,
	view: (run) => ({ opponents: duelOpponents(aliveIds(run)) }),
})
const royaleFinalTwo = finalTwo(royaleMode)
const nemesisFinalTwo = finalTwo(nemesisMode)

// Manhunt and Teams play their own rules; otherwise exactly two players duel
// (ranked is Nemesis with two); Nemesis with more plays the pairing rules; Royale
// with more plays Royale (rank-and-cut down to two alive). The one place that
// decides it: the 3+ game with two players still in the lobby plays the PvP blind rules of a
// duel. `playersStillInLobby` (the started players that have not quit) defaults to the
// started count.
export function pickMode(
	mode: PvpMode,
	startedCount: number,
	playersStillInLobby: number = startedCount,
): Mode {
	if (mode === 'manhunt') return manhuntMode
	if (mode === 'teams') return teamsMode
	if (startedCount === 2) return duelMode
	if (mode === 'nemesis')
		return playersStillInLobby === 2 ? nemesisFinalTwo : nemesisMode
	return playersStillInLobby === 2 ? royaleFinalTwo : royaleMode
}

export function modeOf(run: Run): Mode {
	return pickMode(
		run.rules.mode,
		run.rules.startedCount,
		Object.values(run.lives).filter((seat) => seat.status !== 'left').length,
	)
}
