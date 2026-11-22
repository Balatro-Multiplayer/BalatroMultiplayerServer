// The PvP blind's decisions, on plain data: who plays a Boss and must finish it, what the
// mode sees of a PvP blind, and who loses a life for it. inputs/pvp_blind.ts closes the PvP blind.
import { isAwayPause } from '../core/clock'
import type {
	BigNum,
	BlindKey,
	Countdown,
	PlayerId,
	PvpBlind,
	PvpBlindPlayer,
	Run,
	ScoreView,
} from '../core/types'
import { pickMode } from '../modes/index'
import type { Mode } from '../modes/types'
import { playersOfBoss, requiredPlayers } from './players'

// A personal countdown against a player of the PvP blind: it is paused while the PvP blind plays,
// and dropped when it closes for a player who is out.
export const isPersonalOf = (
	countdown: Countdown,
	currentPvpBlind: PvpBlind,
): boolean =>
	countdown.kind === 'personal' &&
	countdown.against.some(
		(player) => currentPvpBlind.players[player] !== undefined,
	)

export const isAway = (run: Run, player: PlayerId): boolean =>
	run.clocks.playerPauses.some(
		(pause) => pause.player === player && isAwayPause(pause),
	)

// The Boss that opens now: every player it needs is Ready for it, and no PvP blind is being
// played. A Ready player who is away still counts; away only pauses their timers.
export function pvpBlindToOpen(
	run: Run,
): { blindKey: BlindKey; players: PlayerId[] } | null {
	if (run.currentPvpBlind !== null) return null
	for (const blindKey of new Set(Object.values(run.ready))) {
		const players = playersOfBoss(run, blindKey)
		if (
			players.length > 0 &&
			players.every((player) => run.ready[player] === blindKey)
		)
			return { blindKey, players }
	}
	return null
}

// The Boss that waits on `viewer`: their own, while it needs them and at least one player
// needed is Ready. Null when there is none to show.
export function waitingBossOf(
	run: Run,
	viewer: PlayerId,
): { blindKey: BlindKey; players: PlayerId[] } | null {
	const ante = run.players[viewer]?.ante ?? null
	if (ante === null) return null
	const blindKey = `${ante}:Boss`
	const players = playersOfBoss(run, blindKey)
	return players.includes(viewer) &&
		players.some((player) => run.ready[player] === blindKey)
		? { blindKey, players }
		: null
}

// Whether another player's score stays hidden from `viewer`, and what they hold.
export function scoreViewOf(
	currentPvpBlind: PvpBlind,
	viewer: PlayerId,
	player: PlayerId,
): ScoreView {
	const own = currentPvpBlind.players[player]
	if (own === undefined || own.stage === 'not entered')
		return { kind: 'none yet' }
	if (own.score === null) return { kind: 'none yet' }
	return player !== viewer && !mayLookAtScores(currentPvpBlind, viewer)
		? { kind: 'hidden' }
		: { kind: 'shown', score: own.score }
}

export const scoreOf = (own: PvpBlindPlayer): BigNum | null =>
	own.stage === 'not entered' ? null : own.score

export const handsLeftOf = (own: PvpBlindPlayer): number | null =>
	own.stage === 'not entered' ? null : own.handsLeft

export const isDone = (own: PvpBlindPlayer): boolean => own.stage === 'done'

// Whether `viewer` may see the others' scores: only after they played a hand or finished.
export function mayLookAtScores(
	currentPvpBlind: PvpBlind,
	viewer: PlayerId,
): boolean {
	const mine = currentPvpBlind.players[viewer]
	return (
		mine !== undefined &&
		mine.stage !== 'not entered' &&
		mine.stage !== 'entered'
	)
}

// The players whose life this PvP blind costs, or null while the PvP blind is not over. A player
// ended by its own timer loses a life in every PvP blind size. A two-player PvP blind closes the
// moment one of them is timed out; any other closes when the mode says so.
export function losersOf(
	run: Run,
	currentPvpBlind: PvpBlind,
	mode: Mode,
): PlayerId[] | null {
	const required = requiredPlayers(run)
	if (required.length === 0) return null
	const timedOut = required.filter((player) => {
		const own = currentPvpBlind.players[player]
		return own.stage === 'done' && own.endedBy === 'timer'
	})
	if (required.length === 2 && timedOut.length > 0) return timedOut
	const named = mode.losersOf(run, currentPvpBlind)
	if (named === null) return null
	return [...named, ...timedOut.filter((player) => !named.includes(player))]
}
