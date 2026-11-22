import type {
	Countdown,
	PlayerId,
	RunRulesAndLimits,
	State,
} from '../core/types'
import { timerButtonOf, timersView } from '../inputs/timer'
import { BLIND, ready, runOf, send } from './inputs'
import { LIMITS, pairedRun, reported, runState } from './state'

export const BASE = 150_000
export const PVP = { baseMilliseconds: 60_000, handMilliseconds: 15_000 }

export type Change = Partial<RunRulesAndLimits> & { pvpTimer?: boolean }

export function configured(state: State, change: Change): State {
	const run = runOf(state)
	const { pvpTimer, ...rules } = change
	return {
		...state,
		run: {
			...run,
			rules: {
				...run.rules,
				timerBaseMilliseconds: BASE,
				...rules,
				clocks: {
					...run.rules.clocks,
					pvp: pvpTimer === true ? PVP : null,
					...(rules.clocks ?? {}),
				},
			},
		},
	}
}

// A run of `mode` for `players` with the PvP hand timer on or off.
export function runOfMode(
	players: string[],
	mode: 'nemesis' | 'royale',
	change: Change = {},
): State {
	const base = reported(runState(players, LIMITS))
	const run = runOf(base)
	return configured(
		{
			...base,
			run: {
				...run,
				rules: { ...run.rules, mode, startedCount: players.length },
			},
		},
		change,
	)
}

export const countdownsOf = (state: State): Countdown[] =>
	runOf(state).clocks.countdowns
export const livesOf = (state: State, player: string): number =>
	runOf(state).lives[player].lives
export const start = (
	state: State,
	player: string,
	timer: 'ante' | 'pvp',
	now = 0,
) => send(state, player, { kind: 'timerStart', timer }, now)
export const startedFor = (
	state: State,
	player: string,
	timer: 'ante' | 'pvp',
) =>
	countdownsOf(state).filter(
		(countdown) =>
			countdown.kind === timer && countdown.against.includes(player),
	)

// ann is Ready, bob is not: ann times bob with the Ante timer at time 0.
export function anteStarted(change: Change = {}): State {
	const waiting = ready(
		runOfMode(['ann', 'bob'], 'nemesis', change),
		'ann',
	).state
	return start(waiting, 'ann', 'ante').state
}

export const blindStart = (state: State, player: string): State =>
	send(state, player, {
		kind: 'blindStart',
		blindKey: BLIND,
		handsLeft: 4,
		score: '0',
	}).state

export const scored = (
	state: State,
	player: string,
	score: string,
	handsLeft = 3,
	now = 0,
): State =>
	send(
		state,
		player,
		{ kind: 'handScored', blindKey: BLIND, handsLeft, score },
		now,
	).state

export const played = (
	state: State,
	player: string,
	handsLeft = 3,
	now = 0,
): State =>
	send(state, player, { kind: 'handPlayed', blindKey: BLIND, handsLeft }, now)
		.state

// Every player has sent a blind start of 0 in the playing PvP blind (nobody has played a hand).
export function inPvpBlind(
	players = ['ann', 'bob'],
	change: Change = { pvpTimer: true },
): State {
	let state = runOfMode(players, 'nemesis', change)
	for (const player of players) state = ready(state, player).state
	for (const player of players) state = blindStart(state, player)
	return state
}

// The same for three players paired ann-bob with cat on the bye.
export function threeInPvpBlind(): State {
	const base = configured(
		pairedRun(['ann', 'bob', 'cat'], { ann: 'bob', bob: 'ann', cat: null }),
		{ pvpTimer: true },
	)
	let state = base
	for (const player of ['ann', 'bob', 'cat']) state = ready(state, player).state
	for (const player of ['ann', 'bob', 'cat']) state = blindStart(state, player)
	return state
}

// ann has scored 5 against bob's 0 and times bob with the PvP timer at time 1000.
export function pvpStarted(players = ['ann', 'bob']): State {
	const state = scored(inPvpBlind(players), 'ann', '5')
	return start(state, 'ann', 'pvp', 1000).state
}

// The timers read at the run's last settled time.
const settledAt = (state: State) =>
	state.run === null ? 0 : state.run.clocks.settledAt

export const timersViewAtSettle = (state: State, viewer: PlayerId) =>
	timersView(state, viewer, settledAt(state))

export const timerButtonOfAtSettle = (state: State, player: PlayerId) =>
	timerButtonOf(state, player, settledAt(state))
