// What happens when a countdown runs out: the PvP timer ends the player's PvP blind through
// `endPvpBlindFor`; the Ante and personal countdowns cost a forgiven run-out or a life through
// `lives.ts`. Nothing here writes either itself.
import {
	changeClocks,
	isTimed,
	removeCountdowns,
	countdownsAtZero,
	catchUpClocks,
	startCountdown,
} from '../core/clock'
import type {
	BlindKey,
	Countdown,
	Milliseconds,
	PlayerId,
	Run,
	State,
} from '../core/types'
import { changeLedger, handleTimerRunOut } from '../rules/lives'
import { isInRun, playersOfBoss } from '../rules/players'
import { modeOf } from '../modes/index'
import { isDone } from '../rules/pvp_blind_rules'
import { startPersonalClock, syncRates } from './personal_clock'
import { endPvpBlindFor, settlePvpBlind } from './pvp_blind'
import { isStarted, sameCountdown, stopAndBank } from './timer'

const isReadyFor = (run: Run, player: PlayerId, blindKey: BlindKey): boolean =>
	run.ready[player] === blindKey

type AnteCountdown = Extract<Countdown, { kind: 'ante' }>

const isAnte = (countdown: Countdown): countdown is AnteCountdown =>
	countdown.kind === 'ante'

// The players an Ante countdown still presses: of those it was started against, the ones its
// Boss still needs, in the run and not Ready for it.
const pressedBy = (run: Run, countdown: AnteCountdown): PlayerId[] => {
	const { blindKey } = countdown
	const needed = playersOfBoss(run, blindKey)
	return countdown.against.filter(
		(player) =>
			needed.includes(player) &&
			isInRun(run, player) &&
			!isReadyFor(run, player, blindKey),
	)
}

// The time that ran out costs a forgiven run-out or a life, for each player timed. A player
// inside the PvP blind is never handed in: the Ante timer is dropped once the PvP blind plays and
// the personal countdown is paused.
function loseToTimer(
	state: State,
	players: PlayerId[],
	forgiveness: 'applies' | 'none',
): State {
	const run = state.run
	if (run === null) return state
	const mode = modeOf(run)
	const charged = players.filter((player) => isInRun(run, player))
	return changeLedger(state, (before) =>
		charged.reduce(
			(next, player) => handleTimerRunOut(next, mode, player, forgiveness),
			before,
		),
	)
}

// The players whose lives went down between two states.
export function playersWhoLostALife(before: State, after: State): PlayerId[] {
	const lives = before.run?.lives ?? {}
	return Object.keys(lives).filter((player) => {
		const now = after.run?.lives[player]
		return now !== undefined && now.lives < lives[player].lives
	})
}

const costsALife = (countdown: Countdown): boolean =>
	countdown.kind === 'ante' || countdown.kind === 'personal'

// A life lost to a timer ends every other countdown running on the players who lost it.
// An Ante countdown restarts for them as it does after a run-out; a personal one does not.
function clearAfterLoss(
	state: State,
	lost: PlayerId[],
	at: Milliseconds,
): State {
	// Under the personal clock the Ante marker stays against its player.
	const markers = state.run?.rules.clocks.ante === 'personal'
	const hits = (countdown: Countdown): PlayerId[] =>
		costsALife(countdown) && !(markers && countdown.kind === 'ante')
			? countdown.against.filter((player) => lost.includes(player))
			: []
	const cleared = (state.run?.clocks.countdowns ?? []).filter(
		(countdown) => hits(countdown).length > 0,
	)
	const kept = changeClocks(state, (clocks) => ({
		...clocks,
		countdowns: clocks.countdowns.flatMap((countdown) => {
			if (hits(countdown).length === 0) return [countdown]
			const against = countdown.against.filter(
				(player) => !lost.includes(player),
			)
			return against.length === 0 ? [] : [{ ...countdown, against }]
		}),
	}))
	// Under the personal clock the Ante countdown is only a marker: nothing restarts it.
	if (state.run?.rules.clocks.ante === 'personal') return kept
	return cleared
		.filter(isAnte)
		.reduce(
			(next, countdown) =>
				restartAnte(next, { ...countdown, against: hits(countdown) }, at),
			kept,
		)
}

// After an opponent-started Ante timer ended: the players its Boss still needs, in the run
// and not Ready, are timed again from the base time while its starter is still Ready, unless
// a PvP blind is already playing. `now` is when it ended.
function restartAnte(
	state: State,
	ran: AnteCountdown,
	now: Milliseconds,
): State {
	const run = state.run
	if (
		run === null ||
		run.currentPvpBlind !== null ||
		ran.by === null ||
		!playersOfBoss(run, ran.blindKey).includes(ran.by) ||
		!isReadyFor(run, ran.by, ran.blindKey)
	)
		return state
	const against = pressedBy(run, ran)
	if (against.length === 0) return state
	return changeClocks(state, (clocks) =>
		startCountdown(
			clocks,
			{
				kind: 'ante',
				by: ran.by,
				against,
				lengthMilliseconds: run.rules.timerBaseMilliseconds,
				blindKey: ran.blindKey,
			},
			now,
		),
	)
}

// Every PvP, Ante and personal countdown that has run out, earliest first. The PvP timer
// ends the player's PvP blind; the others take a forgiveness or a life, from the players not
// Ready for the Ante timer. A life lost ends the other countdowns on that player (and
// their team), so one tick gives what a tick at every millisecond would.
export function runOutTimers(state: State, now: Milliseconds): State {
	const run = state.run
	if (run === null) return state
	const clocks = catchUpClocks(run.clocks, now)
	const settled: State = { ...state, run: { ...run, clocks } }
	const lost = new Set<PlayerId>()
	const charge = (
		next: State,
		players: PlayerId[],
		countdown: Countdown,
		forgiveness: 'applies' | 'none' = 'applies',
	): State => {
		const charged = loseToTimer(next, players, forgiveness)
		const dropped = playersWhoLostALife(next, charged)
		for (const player of dropped) lost.add(player)
		return dropped.length === 0
			? charged
			: clearAfterLoss(charged, dropped, countdown.endsAt)
	}
	// The marker of the personal clock never runs out.
	const due = countdownsAtZero(clocks, now).filter(
		(ran) => !(ran.kind === 'ante' && run.rules.clocks.ante === 'personal'),
	)
	const ended = due.reduce<State>((next, ran) => {
		const countdown = costsALife(ran)
			? { ...ran, against: ran.against.filter((player) => !lost.has(player)) }
			: ran
		const removed = changeClocks(next, (current) =>
			removeCountdowns(
				current,
				(other) => sameCountdown(other, countdown),
				now,
			),
		)
		if (countdown.kind === 'pvp')
			return run.rules.clocks.pvp !== null
				? countdown.against.reduce(
						(inner, player) => endPvpBlindFor(inner, player, 'timer'),
						removed,
					)
				: removed
		if (countdown.kind === 'ante') {
			const charged = charge(
				removed,
				removed.run === null ? [] : pressedBy(removed.run, countdown),
				countdown,
			)
			return restartAnte(charged, countdown, countdown.endsAt)
		}
		// Speedlatro pays a life with no forgiveness. A Pressure clock that ran out while an
		// Ante countdown timed its player starts again, still timed; otherwise it stays spent.
		const rules = run.rules.clocks.personal
		const timedBefore =
			removed.run === null
				? []
				: countdown.against.filter((player) =>
						isTimed((removed.run as Run).clocks, player),
					)
		const charged = charge(
			removed,
			countdown.against,
			countdown,
			rules?.kind === 'speedlatro' ? 'none' : 'applies',
		)
		if (rules?.kind !== 'pressure') return charged
		return timedBefore.reduce(
			(next, player) =>
				next.run !== null && isInRun(next.run, player)
					? startPersonalClock(
							next,
							player,
							rules.baseMilliseconds,
							countdown.endsAt,
						)
					: next,
			charged,
		)
	}, settled)
	return settlePvpBlind(syncRates(ended, now), now)
}

// Drops the timers nothing needs any more: a starter out of the run, a PvP timer once the
// PvP blind is over or its targets are done, an Ante timer once a PvP blind plays or its Boss needs
// nobody it presses or no longer needs its starter. A starter who is not Ready only pauses it.
export function isUnneededTimer(run: Run, countdown: Countdown): boolean {
	const currentPvpBlind = run.currentPvpBlind
	if (
		isStarted(countdown) &&
		countdown.by !== null &&
		!isInRun(run, countdown.by)
	)
		return true
	if (countdown.kind === 'ante') {
		const { blindKey, by } = countdown
		if (currentPvpBlind !== null) return true
		const needed = playersOfBoss(run, blindKey)
		return (
			(by !== null && !needed.includes(by)) ||
			!countdown.against.some(
				(player) => needed.includes(player) && isInRun(run, player),
			)
		)
	}
	if (countdown.kind !== 'pvp') return false
	return (
		run.rules.clocks.pvp === null ||
		currentPvpBlind === null ||
		countdown.against.every((player) => {
			const own = currentPvpBlind.players[player]
			return own === undefined || isDone(own)
		})
	)
}

export function dropUnneededTimers(state: State, now: Milliseconds): State {
	const run = state.run
	if (run === null) return state
	if (
		!run.clocks.countdowns.some((countdown) => isUnneededTimer(run, countdown))
	)
		return syncRates(state, now)
	return syncRates(
		stopAndBank(state, (countdown) => isUnneededTimer(run, countdown), now),
		now,
	)
}
