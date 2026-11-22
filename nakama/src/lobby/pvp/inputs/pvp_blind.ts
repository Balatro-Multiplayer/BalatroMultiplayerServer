// The PvP blind of a run: when it starts, how its hands are played, who must finish it,
// and how it closes. `endPvpBlindFor` is the only writer of `done`; the step functions at
// the end are what `tick` calls. A PvP blind that is still waiting for Ready is never stored:
// `pvpBlindToOpen` says when it starts.
import type { InputHandler } from '../core/apply'
import {
	changeClocks,
	isCounting,
	isPersonalFor,
	pauseCountdowns,
	refillAnimatingBudgets,
	removeCountdowns,
	resumeCountdowns,
} from '../core/clock'
import { compare } from '../core/score'
import type {
	BigNum,
	BlindKey,
	Countdown,
	EndedBy,
	Milliseconds,
	PlayerId,
	PvpBlind,
	PvpBlindPlayer,
	PvpBlindResult,
	PvpBlindView,
	Run,
	State,
} from '../core/types'
import { modeOf } from '../modes/index'
import { pvpBlindOpponentOf } from '../rules/opponent_targets'
import { skipsAtPvpClose } from '../rules/skips'
import { chargeLife, writeLedger } from '../rules/lives'
import { isStanding } from '../rules/players'
import {
	handsLeftOf,
	isDone,
	isPersonalOf,
	losersOf,
	pvpBlindToOpen,
	scoreOf,
	scoreViewOf,
	waitingBossOf,
} from '../rules/pvp_blind_rules'
import { startPersonalClock } from './personal_clock'
import { addHandTime, stopPassedTimers } from './timer'

// The most hands a player can report.
const MAX_HANDS = 100
export const BLIND_KEY_MAX = 16

// A player who is still in the blind: not done.
type PlayingPlayer = Exclude<PvpBlindPlayer, { stage: 'done' }>

// Starts the PvP blind for `blindKey` with `players`: everyone not entered yet. The Ready marks
// of those players are spent and their personal countdowns pause.
export function startPvpBlind(
	state: State,
	blindKey: BlindKey,
	players: PlayerId[],
	now: Milliseconds,
): State {
	const run = state.run
	if (run === null) return state
	const entries: PvpBlind['players'] = {}
	const ready = { ...run.ready }
	for (const player of players) {
		entries[player] = { stage: 'not entered' }
		delete ready[player]
	}
	const banks: PvpBlind['banks'] = {}
	const pvpTimer = run.rules.clocks.pvp
	if (pvpTimer !== null)
		for (const player of players) banks[player] = pvpTimer.baseMilliseconds
	const currentPvpBlind: PvpBlind = {
		blindKey,
		players: entries,
		banks,
	}
	const started: State = { ...state, run: { ...run, ready, currentPvpBlind } }
	const paused = changeClocks(withBlindClocks(started, now), (clocks) =>
		pauseCountdowns(
			refillAnimatingBudgets(clocks, run.rules.limits, now),
			(countdown) =>
				isPersonalOf(countdown, currentPvpBlind) && isCounting(countdown),
			now,
			'paused for pvp blind',
		),
	)
	return setBlindClock(paused)
}

// Speedlatro: a player of the Boss with no clock (it ran out, or was forgiven) gets one now,
// to be paused for the PvP blind with the others (speedlatro_timer.lua).
function withBlindClocks(state: State, now: Milliseconds): State {
	const run = state.run
	const personal = run?.rules.clocks.personal ?? null
	const currentPvpBlind = run?.currentPvpBlind ?? null
	if (
		run === null ||
		personal?.kind !== 'speedlatro' ||
		currentPvpBlind === null
	)
		return state
	return Object.keys(currentPvpBlind.players).reduce(
		(next, player) =>
			run.clocks.countdowns.some((c) => isPersonalFor(c, player))
				? next
				: startPersonalClock(next, player, personal.pvpMilliseconds, now),
		state,
	)
}

// Speedlatro: each player's clock at their blind start is the blind time.
function setBlindClock(state: State): State {
	const run = state.run
	const personal = run?.rules.clocks.personal ?? null
	const currentPvpBlind = run?.currentPvpBlind ?? null
	if (personal?.kind !== 'speedlatro' || currentPvpBlind === null) return state
	const length = personal.pvpMilliseconds
	return changeClocks(state, (clocks) => ({
		...clocks,
		countdowns: clocks.countdowns.map((countdown) =>
			isPersonalOf(countdown, currentPvpBlind) &&
			countdown.hold.kind !== 'counting'
				? { ...countdown, endsAt: countdown.hold.sinceAt + length }
				: countdown,
		),
	}))
}

// Speedlatro: in the PvP blind a player's clock counts only while the opponent's score is
// strictly higher than theirs.
function runWhileBehind(state: State, now: Milliseconds): State {
	const run = state.run
	const currentPvpBlind = run?.currentPvpBlind ?? null
	if (run === null || currentPvpBlind === null) return state
	if (run.rules.clocks.personal?.kind !== 'speedlatro') return state
	return Object.keys(currentPvpBlind.players).reduce((next, player) => {
		const opponent = pvpBlindOpponentOf(next, currentPvpBlind, player)
		const own = scoreOf(currentPvpBlind.players[player])
		const theirs =
			opponent === null || currentPvpBlind.players[opponent] === undefined
				? null
				: scoreOf(currentPvpBlind.players[opponent])
		// A player who is done is not behind: their clock stops.
		const behind =
			!isDone(currentPvpBlind.players[player]) &&
			own !== null &&
			theirs !== null &&
			compare(theirs, own) > 0
		const mine = (countdown: Countdown): boolean =>
			isPersonalFor(countdown, player)
		return changeClocks(next, (clocks) =>
			behind
				? resumeCountdowns(clocks, mine, now)
				: pauseCountdowns(clocks, mine, now, 'paused for pvp blind'),
		)
	}, state)
}

// The PvP blind starts the moment every player its Boss needs is Ready and here; the shell and
// the core's steps call this once per input and once per tick.
export function openPvpBlindIfReady(state: State, now: Milliseconds): State {
	const run = state.run
	const open = run === null ? null : pvpBlindToOpen(run)
	return open === null
		? state
		: startPvpBlind(state, open.blindKey, open.players, now)
}

function changePvpBlindPlayer(
	state: State,
	player: PlayerId,
	change: (own: PvpBlindPlayer) => PvpBlindPlayer,
): State {
	const run = state.run
	const currentPvpBlind = run?.currentPvpBlind
	const own = currentPvpBlind?.players[player]
	if (!run || !currentPvpBlind || own === undefined) return state
	return {
		...state,
		run: {
			...run,
			currentPvpBlind: {
				...currentPvpBlind,
				players: { ...currentPvpBlind.players, [player]: change(own) },
			},
		},
	}
}

// The only writer of `done`: the player's PvP blind is over, with the score it has. A player
// already done keeps its first reason. This does not resolve the PvP blind: `settlePvpBlind` does.
export function endPvpBlindFor(
	state: State,
	player: PlayerId,
	reason: EndedBy,
): State {
	const own = state.run?.currentPvpBlind?.players[player]
	if (own === undefined || own.stage === 'done') return state
	return changePvpBlindPlayer(state, player, (entry) => ({
		stage: 'done',
		endedBy: reason,
		handsLeft: handsLeftOf(entry),
		score: scoreOf(entry),
	}))
}

// Closes the playing PvP blind when it is over: the losers pay a life and the PvP blind moves to
// `PvP blinds`. Returns the state unchanged while it is still playing.
export function settlePvpBlind(state: State, now: Milliseconds): State {
	const run = state.run
	const currentPvpBlind = run?.currentPvpBlind ?? null
	if (run === null || currentPvpBlind === null) return state
	const mode = modeOf(run)
	const personal = run.rules.clocks.personal
	const losers = losersOf(run, currentPvpBlind, mode)
	if (losers === null) return state
	const payers = mode.lifePool ? mode.lifePool.payers(run, losers) : losers
	const charged = payers.reduce(
		(game, payer) =>
			chargeLife(game, mode, payer, {
				kind: 'pvp_blind',
				number: run.finishedPvpBlinds.length + 1,
				blindKey: currentPvpBlind.blindKey,
			}),
		run,
	)
	const lives = charged.lives
	const result: PvpBlindResult = {
		blindKey: currentPvpBlind.blindKey,
		scores: {},
		endedBy: {},
		losers,
		livesAfter: {},
		teamScores: mode.teamScores?.(run, currentPvpBlind) ?? null,
	}
	for (const player of Object.keys(currentPvpBlind.players)) {
		const own = currentPvpBlind.players[player]
		const seat = lives[player]
		if (seat === undefined) throw new Error(`no lives entry for ${player}`)
		result.scores[player] = scoreOf(own)
		if (own.stage === 'done') result.endedBy[player] = own.endedBy
		result.livesAfter[player] = seat.lives
	}
	const closed: Run = {
		...charged,
		currentPvpBlind: null,
		firstReady: run.firstReady.filter(
			(player) => currentPvpBlind.players[player] === undefined,
		),
		finishedPvpBlinds: [...run.finishedPvpBlinds, result],
		skips: skipsAtPvpClose(run.skips, Object.keys(currentPvpBlind.players)),
		clocks: resumeCountdowns(
			removeCountdowns(
				run.clocks,
				(countdown) =>
					isPersonalOf(countdown, currentPvpBlind) &&
					countdown.against.every((player) => !isStanding(lives[player])),
				now,
			),
			(countdown) => isPersonalOf(countdown, currentPvpBlind),
			now,
		),
	}
	const written = writeLedger(state, run, closed)
	return personal?.kind === 'speedlatro'
		? Object.keys(currentPvpBlind.players)
				.filter((player) => isStanding(lives[player]))
				.reduce(
					(next, player) =>
						startPersonalClock(next, player, personal.baseMilliseconds, now),
					written,
				)
		: written
}

const pvpBlindInputSpec = {
	blindKey: { type: 'text', max: BLIND_KEY_MAX },
	handsLeft: { type: 'whole', max: MAX_HANDS },
} as const
const blindStartSpec = {
	...pvpBlindInputSpec,
	score: { type: 'score' },
} as const
const handPlayedSpec = pvpBlindInputSpec
const handScoredSpec = blindStartSpec

export type PvpBlindInput =
	| { kind: 'blindStart'; blindKey: BlindKey; handsLeft: number; score: BigNum }
	| { kind: 'handPlayed'; blindKey: BlindKey; handsLeft: number }
	| { kind: 'handScored'; blindKey: BlindKey; handsLeft: number; score: BigNum }

// The player's entry in the PvP blind being played, or why a PvP blind input is refused: it must
// name that PvP blind, and its player must not be done.
function playingEntry(
	state: State,
	player: PlayerId,
	blindKey: BlindKey,
): { own: PlayingPlayer } | { refusal: string } {
	const currentPvpBlind = state.run?.currentPvpBlind
	if (!currentPvpBlind) return { refusal: 'no_pvp_blind' }
	if (currentPvpBlind.blindKey !== blindKey) return { refusal: 'wrong_blind' }
	const own = currentPvpBlind.players[player]
	if (own === undefined) return { refusal: 'not_in_pvp_blind' }
	if (own.stage === 'done') return { refusal: 'pvp_blind_done' }
	return { own }
}

// What every PvP blind input does once accepted: the PvP blind closes if that was the last
// thing it waited on. A scored last hand ends the player's PvP blind first.
function afterInput(
	state: State,
	player: PlayerId,
	now: Milliseconds,
	lastHand = false,
): State {
	return settlePvpBlind(
		runWhileBehind(
			lastHand ? endPvpBlindFor(state, player, 'hands') : state,
			now,
		),
		now,
	)
}

export const blindStartHandler: InputHandler<typeof blindStartSpec> = {
	spec: blindStartSpec,
	handle(state, player, body, now) {
		const entry = playingEntry(state, player, body.blindKey)
		if ('refusal' in entry) return entry
		if (entry.own.stage !== 'not entered') return { refusal: 'already_started' }
		const changed = changePvpBlindPlayer(state, player, () => ({
			stage: 'entered',
			handsLeft: body.handsLeft,
			score: body.score,
		}))
		return afterInput(changed, player, now)
	},
}

export const handPlayedHandler: InputHandler<typeof handPlayedSpec> = {
	spec: handPlayedSpec,
	handle(state, player, body, now) {
		const entry = playingEntry(state, player, body.blindKey)
		if ('refusal' in entry) return entry
		const { own } = entry
		if (own.stage === 'not entered') return { refusal: 'not_started' }
		const changed = changePvpBlindPlayer(state, player, () => ({
			stage: 'scoring a hand',
			handsLeft: body.handsLeft,
			score: own.score,
		}))
		return afterInput(addHandTime(changed, player, now), player, now)
	},
}

export const handScoredHandler: InputHandler<typeof handScoredSpec> = {
	spec: handScoredSpec,
	handle(state, player, body, now) {
		const entry = playingEntry(state, player, body.blindKey)
		if ('refusal' in entry) return entry
		if (entry.own.stage === 'not entered') return { refusal: 'not_started' }
		const changed = changePvpBlindPlayer(state, player, () => ({
			stage: 'played a hand',
			handsLeft: body.handsLeft,
			score: body.score,
		}))
		return afterInput(
			stopPassedTimers(changed, now),
			player,
			now,
			body.handsLeft === 0,
		)
	},
}

// The PvP blind as `viewer` sees it: the PvP blind being played, else the waiting PvP blind of the
// viewer's own Boss (who is Ready, nothing more), else none. Another player's score stays
// hidden until the viewer has played a hand or finished; the view says so with `hidden`,
// never by leaving the player out.
export function pvpBlindView(
	state: State,
	viewer: PlayerId,
): PvpBlindView | null {
	const run = state.run
	if (run === null) return null
	const currentPvpBlind = run.currentPvpBlind
	if (currentPvpBlind !== null) {
		const players: Extract<PvpBlindView, { stage: 'playing' }>['players'] = {}
		for (const player of Object.keys(currentPvpBlind.players)) {
			const own = currentPvpBlind.players[player]
			if (own.stage === 'not entered')
				players[player] = { stage: 'not entered' }
			else if (own.stage === 'done')
				players[player] = {
					stage: 'done',
					endedBy: own.endedBy,
					handsLeft: own.handsLeft,
					score: scoreViewOf(currentPvpBlind, viewer, player),
				}
			else
				players[player] = {
					stage: own.stage,
					handsLeft: own.handsLeft,
					score: scoreViewOf(currentPvpBlind, viewer, player),
				}
		}
		return { stage: 'playing', blindKey: currentPvpBlind.blindKey, players }
	}
	const waiting = waitingBossOf(run, viewer)
	if (waiting === null) return null
	const players: Extract<PvpBlindView, { stage: 'waiting' }>['players'] = {}
	for (const player of waiting.players)
		players[player] =
			run.ready[player] === waiting.blindKey ? 'ready' : 'not ready'
	return { stage: 'waiting', blindKey: waiting.blindKey, players }
}
