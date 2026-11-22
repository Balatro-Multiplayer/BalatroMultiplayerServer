// Who is in the run and who plays a PvP blind. A leaf: it imports nothing from rules/, so every
// rule can ask these questions without a cycle.
import type { BlindKey, PlayerId, Run } from '../core/types'
import type { PvpLifePlayer } from './lives'
import { isBlindKey, isBossBlind } from './settings'

// In the run: not out, forfeited or left. Lives are not looked at: a player
// at 0 lives still counts while its waiting death waits.
export function inRunIgnoringLives(
	playerLives: PvpLifePlayer | undefined,
): boolean {
	return playerLives?.status === 'playing'
}

// Standing: in the run with a life left. Also what "alive" means to a mode. A player at 0
// lives with a waiting death still open is in the run (`inRunIgnoringLives`) but not standing.
export const isStanding = (seat: PvpLifePlayer | undefined): boolean =>
	seat !== undefined && seat.lives > 0 && inRunIgnoringLives(seat)

export const isInRun = (run: Run, player: PlayerId): boolean =>
	isStanding(run.lives[player])

// A Boss blind at or after the run's first PvP ante. Any other blind is a normal one.
export function isPvpBlind(run: Run, blindKey: string): boolean {
	if (!isBlindKey(blindKey) || !isBossBlind(blindKey)) return false
	return Number(blindKey.split(':')[0]) >= run.rules.pvpStartAnte
}

const isResolved = (run: Run, blindKey: BlindKey): boolean =>
	run.finishedPvpBlinds.some((done) => done.blindKey === blindKey)

// The players the PvP Boss `blindKey` needs before it can be played: everyone still in the
// run, and nobody for a blind that is not PvP, is already resolved, or would have fewer
// than 2 players. The one rule behind the PvP blind, the Ante timer's targets and the waiting view.
export function playersOfBoss(run: Run, blindKey: BlindKey): PlayerId[] {
	if (!isPvpBlind(run, blindKey) || isResolved(run, blindKey)) return []
	const players = Object.keys(run.lives).filter((player) =>
		isInRun(run, player),
	)
	return players.length >= 2 ? players : []
}

// A PvP blind with this player in it owns its blind's life: the PvP blind being played, a
// finished one, or a Boss that still needs the player. A player with a bye plays the same
// Boss blind as a normal one.
export function playedPvpBlind(
	run: Run,
	player: PlayerId,
	blindKey: BlindKey,
): boolean {
	const open = run.currentPvpBlind
	if (open?.blindKey === blindKey && open.players[player] !== undefined)
		return true
	return (
		run.finishedPvpBlinds.some(
			(done) => done.blindKey === blindKey && player in done.scores,
		) || playersOfBoss(run, blindKey).includes(player)
	)
}

// Whether `blindKey` is a PvP blind that `player` plays: a loss on it is the PvP blind's own life.
export const isPvpBlindOf = (
	run: Run,
	player: PlayerId,
	blindKey: BlindKey,
): boolean => isPvpBlind(run, blindKey) && playedPvpBlind(run, player, blindKey)

// The one definition of a required player: in the PvP blind being played and still in the run
// with a life left. A player who left, was removed or is out is not required.
export function requiredPlayers(run: Run): PlayerId[] {
	if (run.currentPvpBlind === null) return []
	return Object.keys(run.currentPvpBlind.players).filter((player) =>
		isInRun(run, player),
	)
}
