// The countdowns a player starts, pauses and spends on: the PvP timer, the Ante timer and
// the personal countdown. What happens when one runs out is `timer_run_out.ts`. This file must
// not import `pvp_blind.ts`: `pvp_blind.ts` calls `addHandTime` from here.
import type { Handled, InputHandler } from '../core/apply'
import {
	changeClocks,
	endPlayerPause,
	isCounting,
	isPersonalFor,
	pauseCountdowns,
	pauseApplies,
	pauseLeft,
	removeCountdowns,
	resumeCountdowns,
	setPausedAfter,
	catchUpClocks,
	startCountdown,
	startPlayerPause,
	stoppedAt,
	timeLeft,
} from '../core/clock'
import { compare } from '../core/score'
import type {
	BlindKey,
	Clocks,
	Countdown,
	Deadline,
	Milliseconds,
	Pause,
	PlayerId,
	PvpBlind,
	Run,
	State,
	TimersView,
} from '../core/types'
import { opponentsOf, pvpBlindOpponentOf } from '../rules/opponent_targets'
import { isInRun, playersOfBoss } from '../rules/players'
import { handsLeftOf, isAway, isDone, scoreOf } from '../rules/pvp_blind_rules'
import { anteBankOf as skipBank, skipEntryOf } from '../rules/skips'

// The most paid Score Previews a run can report.
const MOST_PAID_PREVIEWS = 100_000
// A Score Preview is free while the clock has this much or less left, or the cost itself.
const FREE_PREVIEW_MILLISECONDS = 10_000

export type TimerInput =
	| { kind: 'timerStart'; timer: 'ante' | 'pvp' }
	| { kind: 'timerPause' }
	| { kind: 'paidPreviews'; total: number }
	| { kind: 'animating'; on: boolean }

const startSpec = { timer: { type: 'oneOf', values: ['ante', 'pvp'] } } as const
const pauseSpec = {} as const
const spendSpec = { total: { type: 'whole', max: MOST_PAID_PREVIEWS } } as const
const animatingSpec = { on: { type: 'flag' } } as const

export const isStarted = (countdown: Countdown): boolean =>
	countdown.kind === 'ante' || countdown.kind === 'pvp'

// The same countdown: what it is, who started it and who it is against.
export const sameCountdown = (left: Countdown, right: Countdown): boolean =>
	left.kind === right.kind &&
	left.by === right.by &&
	left.against.length === right.against.length &&
	left.against.every((player, place) => player === right.against[place])

function writeBank(state: State, player: PlayerId, left: Milliseconds): State {
	const run = state.run
	const currentPvpBlind = run?.currentPvpBlind
	if (!run || !currentPvpBlind || currentPvpBlind.banks[player] === undefined)
		return state
	return {
		...state,
		run: {
			...run,
			currentPvpBlind: {
				...currentPvpBlind,
				banks: { ...currentPvpBlind.banks, [player]: Math.max(0, left) },
			},
		},
	}
}

// A hand played adds the hand time to the player's bank, timed or not. A PvP countdown
// against them that still has time gets it too.
export function addHandTime(
	state: State,
	player: PlayerId,
	now: Milliseconds,
): State {
	const pvp = state.run?.rules.clocks.pvp ?? null
	const bank = state.run?.currentPvpBlind?.banks[player]
	if (pvp === null || bank === undefined) return state
	return changeClocks(
		writeBank(state, player, bank + pvp.handMilliseconds),
		(clocks) => ({
			...clocks,
			countdowns: clocks.countdowns.map((countdown) =>
				countdown.kind === 'pvp' &&
				countdown.against.includes(player) &&
				timeLeft(countdown, now) > 0
					? { ...countdown, endsAt: countdown.endsAt + pvp.handMilliseconds }
					: countdown,
			),
		}),
	)
}

// `player` is ahead of `other` on the scores in the PvP blind: higher, or level and Ready first.
function isAhead(
	run: Run,
	currentPvpBlind: PvpBlind,
	player: PlayerId,
	other: PlayerId,
): boolean {
	const own = currentPvpBlind.players[player]
	const theirs = currentPvpBlind.players[other]
	if (own === undefined || theirs === undefined) return false
	const ownScore = scoreOf(own)
	const theirScore = scoreOf(theirs)
	if (ownScore === null || theirScore === null) return false
	const order = compare(ownScore, theirScore)
	return order > 0 || (order === 0 && run.firstReady.includes(player))
}

// Writes the time left of the chosen PvP countdowns back to their targets' banks.
function bankTimeLeft(
	state: State,
	which: (countdown: Countdown) => boolean,
	now: Milliseconds,
): State {
	const clocks =
		state.run === null ? null : catchUpClocks(state.run.clocks, now)
	if (clocks === null) return state
	return clocks.countdowns
		.filter((countdown) => countdown.kind === 'pvp' && which(countdown))
		.reduce(
			(game, countdown) =>
				countdown.against.reduce(
					(inner, target) => writeBank(inner, target, timeLeft(countdown, now)),
					game,
				),
			state,
		)
}

// Removes the chosen countdowns; a PvP one banks its time left first.
export function stopAndBank(
	state: State,
	which: (countdown: Countdown) => boolean,
	now: Milliseconds,
): State {
	return changeClocks(bankTimeLeft(state, which, now), (clocks) =>
		removeCountdowns(clocks, which, now),
	)
}

// A resumed PvP countdown has what its target's bank holds: another starter may have used
// time since this one paused.
function resumeFromBank(
	state: State,
	starter: PlayerId,
	now: Milliseconds,
): State {
	const banks = state.run?.currentPvpBlind?.banks
	if (banks === undefined) return state
	return changeClocks(state, (clocks) => ({
		...clocks,
		countdowns: clocks.countdowns.map((countdown) => {
			const bank = banks[countdown.against[0]]
			return countdown.kind === 'pvp' &&
				countdown.by === starter &&
				bank !== undefined
				? { ...countdown, endsAt: (stoppedAt(countdown) ?? now) + bank }
				: countdown
		}),
	}))
}

// After a score: a PvP countdown whose starter is no longer ahead of its target stops,
// unless its time is already up (the run-out decides that).
export function stopPassedTimers(state: State, now: Milliseconds): State {
	const run = state.run
	const currentPvpBlind = run?.currentPvpBlind
	if (!run || !currentPvpBlind) return state
	const passed = (countdown: Countdown): boolean => {
		const starter = countdown.by
		return (
			countdown.kind === 'pvp' &&
			starter !== null &&
			timeLeft(countdown, now) > 0 &&
			!countdown.against.every((target) =>
				isAhead(run, currentPvpBlind, starter, target),
			)
		)
	}
	return stopAndBank(state, passed, now)
}

// The length of the Ante countdown `player` starts (main announces the starter's own timer):
// the base plus the skip time, the lead measured against the starter's opponent.
function anteBankIn(state: State, run: Run, player: PlayerId): Milliseconds {
	const base = run.rules.timerBaseMilliseconds
	if (run.rules.clocks.ante === 'personal') return base
	const opponent = opponentsOf(state, player).one
	return skipBank(
		base,
		run.rules.timerIncrementMilliseconds,
		run.rules.skipTimeRule,
		skipEntryOf(run.skips, player),
		opponent === null ? null : skipEntryOf(run.skips, opponent),
	)
}

// Under the personal clock the Ante countdown is only a marker; it is as long as the timed
// player's own time left, the base when they have none.
function personalLeft(
	run: Run,
	player: PlayerId,
	now: Milliseconds,
): Milliseconds {
	const own = run.clocks.countdowns.find((countdown) =>
		isPersonalFor(countdown, player),
	)
	return own === undefined
		? run.rules.timerBaseMilliseconds
		: timeLeft(own, now)
}

type StartCheck =
	| { timer: 'pvp'; against: PlayerId[]; lengthMilliseconds: number }
	| {
			timer: 'ante'
			against: PlayerId[]
			lengthMilliseconds: number
			blindKey: BlindKey
	  }
	| { refusal: string }

// The player the PvP timer of `player` would run against: the opponent of the PvP blind's
// ante pairing, only while the opponent is not done and `player` is ahead on the score they
// can see, or level with it and got there first.
function pvpTarget(
	state: State,
	run: Run,
	currentPvpBlind: PvpBlind,
	player: PlayerId,
): { target: PlayerId } | { refusal: string } {
	const own = currentPvpBlind.players[player]
	if (own === undefined || handsLeftOf(own) === null)
		return { refusal: 'not_in_pvp_blind' }
	const target = pvpBlindOpponentOf(state, currentPvpBlind, player)
	if (target === null) return { refusal: 'no_opponent' }
	const theirs = currentPvpBlind.players[target]
	if (
		theirs === undefined ||
		isDone(theirs) ||
		handsLeftOf(theirs) === null ||
		!isInRun(run, target)
	)
		return { refusal: 'nobody_to_time' }
	// A last hand still scoring (played, not scored yet) must not be timed out.
	if (handsLeftOf(theirs) === 0) return { refusal: 'out_of_hands' }
	return isAhead(run, currentPvpBlind, player, target)
		? { target }
		: { refusal: 'not_ahead' }
}

function whoToTime(
	state: State,
	run: Run,
	player: PlayerId,
	timer: 'ante' | 'pvp',
	now: Milliseconds,
): StartCheck {
	const currentPvpBlind = run.currentPvpBlind
	if (timer === 'pvp') {
		const pvp = run.rules.clocks.pvp
		if (pvp === null) return { refusal: 'pvp_timer_off' }
		if (currentPvpBlind === null) return { refusal: 'not_pvp_blind' }
		const found = pvpTarget(state, run, currentPvpBlind, player)
		if ('refusal' in found) return found
		const bank = currentPvpBlind.banks[found.target]
		if (bank === undefined) return { refusal: 'no_bank' }
		return { timer: 'pvp', against: [found.target], lengthMilliseconds: bank }
	}
	if (currentPvpBlind !== null) return { refusal: 'not_waiting' }
	const blindKey = run.ready[player]
	if (blindKey === undefined) return { refusal: 'not_ready' }
	const needed = playersOfBoss(run, blindKey)
	if (!needed.includes(player)) return { refusal: 'not_waiting' }
	const against = needed
		.slice()
		.sort()
		.filter(
			(id) => id !== player && isInRun(run, id) && run.ready[id] !== blindKey,
		)
	if (against.length === 0) return { refusal: 'nobody_to_time' }
	return {
		timer: 'ante',
		against,
		lengthMilliseconds:
			run.rules.clocks.ante === 'personal'
				? Math.min(...against.map((id) => personalLeft(run, id, now)))
				: anteBankIn(state, run, player),
		blindKey,
	}
}

// Whether `player` may start `timer` now, and who it would time. One direction at a time: a
// player an opponent's timer counts against cannot start one, and a player already timed
// this way is not timed twice (first press wins). The only place these are decided: the
// view's button and the input both come here.
function startCheck(
	state: State,
	player: PlayerId,
	timer: 'ante' | 'pvp',
	now: Milliseconds,
): StartCheck {
	const run = state.run
	if (run === null) return { refusal: 'no_run' }
	if (!isInRun(run, player)) return { refusal: 'eliminated' }
	const countdowns = run.clocks.countdowns
	if (
		countdowns.some(
			(countdown) =>
				isStarted(countdown) &&
				isCounting(countdown) &&
				countdown.by !== null &&
				countdown.by !== player &&
				countdown.against.includes(player),
		)
	)
		return { refusal: 'being_timed' }
	// The starter's own paused timer may start again; a counting one is already running.
	if (
		countdowns.some(
			(countdown) =>
				countdown.kind === timer &&
				countdown.by === player &&
				isCounting(countdown),
		)
	)
		return { refusal: 'already_running' }
	const found = whoToTime(state, run, player, timer, now)
	if ('refusal' in found) return found
	const taken = countdowns.some(
		(countdown) =>
			countdown.kind === timer &&
			isCounting(countdown) &&
			countdown.by !== player &&
			countdown.against.some((id) => found.against.includes(id)),
	)
	if (taken) return { refusal: 'already_timed' }
	// No timer starts while a player of the run is away: they would be hit on return.
	return Object.keys(run.players).some(
		(id) => isInRun(run, id) && isAway(run, id),
	)
		? { refusal: 'someone_away' }
		: found
}

// Which timer the player may start now. The Ante timer needs no PvP blind playing and the PvP
// timer needs one, so at most one answers.
export function timerButtonOf(
	state: State,
	player: PlayerId,
	now: Milliseconds,
): TimersView['timerButton'] {
	if (state.run === null) return 'none'
	let button: TimersView['timerButton'] = 'none'
	for (const timer of ['ante', 'pvp'] as const) {
		const checked = startCheck(state, player, timer, now)
		if ('against' in checked) return timer
		if (checked.refusal === 'someone_away') button = 'someone away'
	}
	return button
}

export const timerStartHandler: InputHandler<typeof startSpec> = {
	spec: startSpec,
	handle(state, player, body, now): Handled {
		const checked = startCheck(state, player, body.timer, now)
		if ('refusal' in checked) return checked
		// A countdown frozen for a Ready target is not a paused one: it needs no restart.
		const held = state.run?.clocks.countdowns.some(
			(countdown) =>
				countdown.kind === body.timer &&
				countdown.by === player &&
				countdown.hold.kind !== 'paused for ready',
		)
		// A personal countdown stopped by Ready runs again while an Ante countdown times its player.
		const timedNow = (clocks: Clocks): Clocks =>
			body.timer === 'ante'
				? setPausedAfter(
						resumeCountdowns(
							clocks,
							(countdown) =>
								countdown.kind === 'personal' &&
								countdown.against.some((id) => checked.against.includes(id)),
							now,
						),
						player,
						'counting',
					)
				: clocks
		if (held === true) {
			const resumed = changeClocks(state, (clocks) =>
				timedNow(
					resumeCountdowns(
						clocks,
						(countdown) =>
							countdown.kind === body.timer && countdown.by === player,
						now,
					),
				),
			)
			return body.timer === 'pvp'
				? resumeFromBank(resumed, player, now)
				: resumed
		}
		return changeClocks(state, (clocks) =>
			timedNow(
				startCountdown(
					clocks,
					checked.timer === 'ante'
						? {
								kind: 'ante',
								by: player,
								against: checked.against,
								lengthMilliseconds: checked.lengthMilliseconds,
								blindKey: checked.blindKey,
							}
						: {
								kind: 'pvp',
								by: player,
								against: checked.against,
								lengthMilliseconds: checked.lengthMilliseconds,
							},
					now,
				),
			),
		)
	},
}

// Only the starter stops a timer it started.
export const timerPauseHandler: InputHandler<typeof pauseSpec> = {
	spec: pauseSpec,
	handle(state, player, _body, now): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		const own = (countdown: Countdown): boolean =>
			isStarted(countdown) && countdown.by === player
		if (
			!run.clocks.countdowns.some(
				(countdown) => own(countdown) && isCounting(countdown),
			)
		)
			return { refusal: 'no_timer_to_pause' }
		// A stopped Ante timer stops the personal countdown of the players it was timing,
		// unless another counting Ante countdown still times them.
		const freed = run.clocks.countdowns
			.filter(
				(countdown) =>
					own(countdown) && countdown.kind === 'ante' && isCounting(countdown),
			)
			.flatMap((countdown) => countdown.against)
		const banked = bankTimeLeft(
			state,
			(countdown) => own(countdown) && isCounting(countdown),
			now,
		)
		return changeClocks(banked, (clocks) => {
			const paused = setPausedAfter(
				pauseCountdowns(clocks, own, now),
				player,
				'paused by starter',
			)
			const stillTimed = (id: PlayerId): boolean =>
				paused.countdowns.some(
					(countdown) =>
						countdown.kind === 'ante' &&
						isCounting(countdown) &&
						countdown.against.includes(id),
				)
			return pauseCountdowns(
				paused,
				(countdown) =>
					countdown.kind === 'personal' &&
					countdown.against.every(
						(id) => freed.includes(id) && !stillTimed(id),
					),
				now,
				'paused until timed',
			)
		})
	},
}

// Each paid Score Preview takes the server's cost off the player's personal countdown, unless
// the clock is already at or below the free floor.
export const paidPreviewsHandler: InputHandler<typeof spendSpec> = {
	spec: spendSpec,
	handle(state, player, body, now, previousTotal): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		const personal = run.rules.clocks.personal
		if (personal === null) return { refusal: 'no_timer' }
		const clocks = catchUpClocks(run.clocks, now)
		const ownAt = clocks.countdowns.findIndex((countdown) =>
			isPersonalFor(countdown, player),
		)
		const own = clocks.countdowns[ownAt]
		if (own === undefined || own.kind !== 'personal')
			return { refusal: 'no_timer' }
		const cost = personal.previewCostMilliseconds
		const uses = body.total - (previousTotal ?? 0)
		const free = Math.max(FREE_PREVIEW_MILLISECONDS, cost)
		// The cost and the free floor are in clock time; at rate 2 a second of clock is half
		// a second of wall time.
		const left = timeLeft(own, now) * own.rate
		if (cost <= 0 || left <= free) return { ...state, run: { ...run, clocks } }
		const paid = Math.min(uses, Math.ceil((left - free) / cost))
		return {
			...state,
			run: {
				...run,
				clocks: {
					...clocks,
					countdowns: clocks.countdowns.map((countdown, at) =>
						at === ownAt
							? {
									...countdown,
									endsAt:
										countdown.endsAt - Math.round((paid * cost) / own.rate),
								}
							: countdown,
					),
				},
			},
		}
	},
}

// A player out of the run may end a pause it has, never start one.
export const animatingHandler: InputHandler<typeof animatingSpec> = {
	spec: animatingSpec,
	handle(state, player, body, now): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		if (run.clocks.players[player] === undefined)
			return { refusal: 'unknown_player' }
		// The wire carries a flag; the part works with the named state.
		const pause: 'started' | 'stopped' = body.on ? 'started' : 'stopped'
		if (pause === 'started' && !isInRun(run, player))
			return { refusal: 'eliminated' }
		return changeClocks(state, (clocks) =>
			pause === 'started'
				? startPlayerPause(clocks, player, 'animating', run.rules.limits, now)
				: endPlayerPause(clocks, player, 'animating', now),
		)
	},
}

// The countdowns that involve `viewer`, as the shared deadline shape, and the pauses that
// are stopping them now.
export function timersView(
	state: State,
	viewer: PlayerId,
	now: Milliseconds,
): TimersView {
	const run = state.run
	if (run === null)
		return {
			timerButton: 'none',
			deadlines: [],
			pauses: [],
			pvpBanks: {},
			anteBanks: {},
		}
	const { clocks } = run
	const threshold = run.rules.timerDisplayThresholdMilliseconds
	// A started Ante countdown stays hidden from the player it times until its time left is at
	// or below the threshold (main holds the announcement back); its starter sees it at once.
	const heldBack = (countdown: Countdown): boolean =>
		threshold !== null &&
		countdown.kind === 'ante' &&
		countdown.by !== viewer &&
		timeLeft(countdown, now) > threshold
	const seen = clocks.countdowns.filter(
		(countdown) =>
			(countdown.by === viewer || countdown.against.includes(viewer)) &&
			!heldBack(countdown),
	)
	const deadlines: Deadline[] = seen.map((countdown) => ({
		kind: countdown.kind,
		by: countdown.by,
		against: countdown.against,
		endsAt: countdown.endsAt,
		pausedAt: stoppedAt(countdown),
		hold: countdown.hold.kind,
		...(countdown.kind === 'personal' ? { rate: countdown.rate } : {}),
	}))
	const pauses: Pause[] = []
	const heldSeen = seen.filter(
		(countdown) => countdown.hold.kind === 'held for player',
	)
	if (heldSeen.length > 0)
		for (const reason of ['away', 'animating'] as const) {
			const active = clocks.playerPauses.filter(
				(pause) =>
					pause.reason === reason &&
					pauseLeft(clocks, pause) > 0 &&
					heldSeen.some((countdown) => pauseApplies(pause, countdown)),
			)
			if (active.length === 0) continue
			pauses.push({
				reason,
				players: active.map((pause) => pause.player).sort(),
				endsAt: Math.min(
					...active.map((pause) => clocks.settledAt + pauseLeft(clocks, pause)),
				),
			})
		}
	return {
		timerButton: timerButtonOf(state, viewer, now),
		deadlines,
		pauses,
		pvpBanks: run.currentPvpBlind?.banks ?? {},
		anteBanks: Object.fromEntries(
			Object.keys(run.players).map((player) => [
				player,
				anteBankIn(state, run, player),
			]),
		),
	}
}
