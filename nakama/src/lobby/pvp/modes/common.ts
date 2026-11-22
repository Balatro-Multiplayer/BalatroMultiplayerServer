// What the modes share: the roster every mode starts with, the win check of a
// last-one-standing game (duel, Royale, Nemesis), and the small questions every mode asks of
// the run. Every rule is pure and reads the run; it never changes it.
import { type Ending, drawEnding, winEnding } from '../core/ending'
import type { PlayerId, PvpBlind, Run } from '../core/types'
import type { PvpLifePlayer } from '../rules/lives'
import type { PvpSettings } from '../rules/settings'
import type {
	Mode,
	Opponents,
	PvpPairing,
	RunStart,
	TargetsShown,
} from './types'

// Alive: in the run AND a life left. `inRunIgnoringLives` (rules/players.ts) is the other
// rule: it ignores lives, so a player at 0 with a waiting death still counts.
// A mode decides who plays on with this; the shared code that waits on a player
// uses `inRunIgnoringLives`.
export const inRunWithLives = (player: PvpLifePlayer): boolean =>
	player.lives > 0 && player.status === 'playing'

export const isAlive = (run: Run, id: PlayerId): boolean => {
	const seat = run.lives[id]
	return seat !== undefined && inRunWithLives(seat)
}

export const aliveIds = (run: Run): PlayerId[] =>
	Object.keys(run.lives)
		.filter((id) => isAlive(run, id))
		.sort()

// The alive players of this PvP blind: only the players it started with count.
export const aliveInPvpBlind = (
	run: Run,
	currentPvpBlind: PvpBlind,
): PlayerId[] =>
	Object.keys(currentPvpBlind.players)
		.filter((id) => isAlive(run, id))
		.sort()

// The highest ante any player has reported, null when none has.
export const highestAnte = (run: Run): number | null =>
	Object.keys(run.lives).reduce<number | null>((best, id) => {
		const ante = run.players[id]?.ante ?? null
		return ante === null ? best : best === null ? ante : Math.max(best, ante)
	}, null)

// The score a player has reported this PvP blind, null when none (or no entry).
export const scoreOf = (
	currentPvpBlind: PvpBlind,
	id: PlayerId,
): string | null => {
	const own = currentPvpBlind.players[id]
	return own === undefined || own.stage === 'not entered' ? null : own.score
}

// True when every one of `ids` is done with its hands. A player with no entry is not done.
export const allOutOfHands = (
	currentPvpBlind: PvpBlind,
	ids: PlayerId[],
): boolean => ids.every((id) => currentPvpBlind.players[id]?.stage === 'done')

// A player who has not reported a hand count yet: not in the blind, or still playing and
// reporting 0 hands (a hand not yet scored).
export const hasNotReported = (
	currentPvpBlind: PvpBlind,
	id: PlayerId,
): boolean => {
	const own = currentPvpBlind.players[id]
	if (own === undefined || own.stage === 'not entered') return true
	return own.stage !== 'done' && own.handsLeft === 0
}

// The pairing made for `ante`; null while there is none.
export const pairingOfAnte = (
	run: Run,
	ante: number | null,
): PvpPairing | null => (ante === null ? null : (run.pairings[ante] ?? null))

// The pairing of the highest ante paired so far, which the next one builds on; null while
// nobody is paired.
export function latestPairing(run: Run): PvpPairing | null {
	const antes = Object.keys(run.pairings).map(Number)
	return antes.length === 0 ? null : run.pairings[Math.max(...antes)]
}

// Every started player, with the starting lives, in id order.
export function startingLives(
	rules: PvpSettings,
	start: RunStart,
): { [id: PlayerId]: PvpLifePlayer } {
	const lives: { [id: PlayerId]: PvpLifePlayer } = {}
	for (const id of [...start.startedIds].sort())
		lives[id] = {
			lives: rules.startingLives,
			status: 'playing',
			events: [],
		}
	return lives
}

// The match ends when one player is left standing (the one with more
// lives wins), or none is left (a draw).
export function lastPlayerStanding(run: Run): Ending | null {
	const alive = aliveIds(run)
	if (alive.length > 1) return null
	return alive.length === 1 ? winEnding(run, alive) : drawEnding(run)
}

// The opponent the mode shows the player is the one opponent, and the only one a card hits.
export function singleOpponent(
	actor: PlayerId,
	shown: TargetsShown,
): Opponents {
	const one = shown.opponents[actor] ?? null
	return { one, each: one === null ? [] : [one] }
}

// What Duel, Royale and Nemesis share: the starting roster, last one standing and one opponent,
// unpaired (Nemesis sets its own pairing). A mode spreads it and fills the rest.
export const lastStandingBase: Pick<
	Mode,
	'pairs' | 'init' | 'checkWinner' | 'pickOpponents'
> = {
	pairs: 'none',
	init: (rules, start) => ({
		lives: startingLives(rules, start),
		teams: {},
		teamLives: null,
		cardTargets: null,
	}),
	checkWinner: lastPlayerStanding,
	pickOpponents: (_run, actor, shown) => singleOpponent(actor, shown),
}
