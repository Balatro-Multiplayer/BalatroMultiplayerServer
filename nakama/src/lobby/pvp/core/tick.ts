// The timed rules of a run, in the one order `tick` runs them: stale timers, timers that ran
// out, the PvP blind that is ready to open, waiting deaths, then the winner. A
// PvP blind that a run-out closes is closed inside its step, so the deaths and
// the winner always see its lives. Away and grace are the lobby's: the shell marks a player
// away or gone before it calls `tick`.
import { decideMatch, settleWaitingDeaths } from '../inputs/finish'
import { openPvpBlindIfReady } from '../inputs/pvp_blind'
import {
	dropUnneededTimers,
	isUnneededTimer,
	runOutTimers,
} from '../inputs/timer_run_out'
import { countdownsAtZero, catchUpClocks } from './clock'
import type { Milliseconds, State } from './types'

// What the lobby knows and the core does not.
interface TickFacts {
	ranked: boolean
}

// The match, decided: waiting deaths first, since one that still waits holds `decideMatch`.
// The shell calls this after every input and `tick` calls it last.
export function settleMatch(state: State, facts: TickFacts): State {
	return decideMatch(settleWaitingDeaths(state, facts.ranked), facts.ranked)
}

// Whether a countdown has run out or a timer has gone stale at `now`.
function timersDue(state: State, now: Milliseconds): boolean {
	const run = state.run
	if (run === null) return false
	const clocks = catchUpClocks(run.clocks, now)
	return (
		countdownsAtZero(clocks, now).length > 0 ||
		clocks.countdowns.some((countdown) => isUnneededTimer(run, countdown))
	)
}

// Nothing due: the same object, so a quiet tick changes no view. A decided match is final.
export function tick(state: State, now: Milliseconds, facts: TickFacts): State {
	if (state.run === null || state.result !== null) return state
	const timed = timersDue(state, now)
		? runOutTimers(dropUnneededTimers(state, now), now)
		: state
	return settleMatch(openPvpBlindIfReady(timed, now), facts)
}
