// The personal clock of Pressure and Speedlatro: one countdown per player that the Ante
// timer only speeds up. Creation, the rate while timed, and the skip time an opponent gives.
// It must not import `pvp_blind.ts` or `timer_run_out.ts`: both call it.
import {
	changeClocks,
	isCounting,
	isPersonalFor,
	isTimed,
	removeCountdowns,
	catchUpClocks,
	startCountdown,
	stoppedAt,
} from '../core/clock'
import type { Milliseconds, PlayerId, State } from '../core/types'
import { isInRun } from '../rules/players'

// A player's personal countdown starts over with `lengthMilliseconds`, counting at rate 1.
export function startPersonalClock(
	state: State,
	player: PlayerId,
	lengthMilliseconds: number,
	now: Milliseconds,
): State {
	const run = state.run
	if (run === null || !isInRun(run, player)) return state
	return changeClocks(state, (clocks) =>
		startCountdown(
			removeCountdowns(
				clocks,
				(countdown) => isPersonalFor(countdown, player),
				now,
			),
			{
				kind: 'personal',
				by: null,
				against: [player],
				lengthMilliseconds,
			},
			now,
		),
	)
}

// Pressure restarts the clock at each ante the player reaches; Speedlatro starts it once,
// at the player's first report (a run-out leaves it off until the PvP blind closes).
export function startAtAnte(
	state: State,
	player: PlayerId,
	firstReport: boolean,
	now: Milliseconds,
): State {
	const personal = state.run?.rules.clocks.personal ?? null
	if (personal === null) return state
	if (personal.kind === 'speedlatro' && !firstReport) return state
	return startPersonalClock(state, player, personal.baseMilliseconds, now)
}

// A personal countdown runs at the timed rate while an Ante countdown presses its player and
// at rate 1 otherwise; a change of rate scales the time left, so the time left in clock
// time stays the same.
export function syncRates(state: State, now: Milliseconds): State {
	const run = state.run
	const personal = run?.rules.clocks.personal ?? null
	if (run === null || personal === null) return state
	const wanted = (player: PlayerId): 1 | 2 =>
		isTimed(run.clocks, player) ? personal.timedRate : 1
	if (
		!run.clocks.countdowns.some(
			(countdown) =>
				countdown.kind === 'personal' &&
				countdown.rate !== wanted(countdown.against[0]),
		)
	)
		return state
	return changeClocks(state, (clocks) => {
		const settled = catchUpClocks(clocks, now)
		return {
			...settled,
			countdowns: settled.countdowns.map((countdown) => {
				if (countdown.kind !== 'personal') return countdown
				const rate = wanted(countdown.against[0])
				if (rate === countdown.rate) return countdown
				const at = stoppedAt(countdown) ?? now
				const left = Math.round(((countdown.endsAt - at) * countdown.rate) / rate)
				return { ...countdown, rate, endsAt: at + left }
			}),
		}
	})
}

// An opponent's skip gives the player `milliseconds` of clock time while nobody times them
// and they time nobody (main: nemesis.lua, the Pressure and no-animation timers).
export function addSkipTime(
	state: State,
	player: PlayerId,
	milliseconds: number,
): State {
	const run = state.run
	if (run === null || run.rules.clocks.personal?.kind !== 'pressure') return state
	const started = run.clocks.countdowns.some(
		(countdown) =>
			countdown.kind === 'ante' &&
			isCounting(countdown) &&
			(countdown.by === player || countdown.against.includes(player)),
	)
	if (started) return state
	return changeClocks(state, (clocks) => ({
		...clocks,
		countdowns: clocks.countdowns.map((countdown) =>
			countdown.kind === 'personal' && countdown.against.includes(player)
				? {
						...countdown,
						endsAt: countdown.endsAt + Math.round(milliseconds / countdown.rate),
					}
				: countdown,
		),
	}))
}
