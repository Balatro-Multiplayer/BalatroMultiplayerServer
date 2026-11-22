// Getting every player to a PvP blind: `ready` and `team`. This part writes a player's
// `run.ready` mark; inputs/pvp_blind.ts starts and closes the PvP blind.
import type { InputHandler } from '../core/apply'
import {
	changeClocks,
	pauseForReady,
	isCounting,
	isPersonalFor,
	pauseCountdowns,
	resumeCountdowns,
	setPausedAfter,
	resumeAfterReady,
} from '../core/clock'
import type { BlindKey, Clocks, Countdown, State, Team } from '../core/types'
import { pickMode } from '../modes/index'
import { isInRun, isPvpBlind, playersOfBoss } from '../rules/players'
import { BLIND_KEY_MAX } from './pvp_blind'

export type EntryInput =
	| { kind: 'ready'; ready: boolean; blindKey: BlindKey }
	| { kind: 'team'; team: Team }

const readySpec = {
	ready: { type: 'flag' },
	blindKey: { type: 'text', max: BLIND_KEY_MAX },
} as const

const teamSpec = {
	team: { type: 'oneOf', values: ['A', 'B', 'RUNNER', 'HUNTER'] },
} as const

// Ready is a mark on the run, never a stored PvP blind: the PvP blind starts when `pvpBlindToOpen`
// says every player still in is Ready and here. Refusals, in this order: not a PvP Boss, a
// player out of the run, a Boss already resolved, another Boss being played, this Boss
// already playing.
export const readyHandler: InputHandler<typeof readySpec> = {
	spec: readySpec,
	handle(state, player, body, now) {
		const run = state.run
		if (run === null) return { refusal: 'no_pvp_blind' }
		const { blindKey } = body
		if (!isPvpBlind(run, blindKey)) return { refusal: 'not_pvp_blind' }
		if (!isInRun(run, player)) return { refusal: 'eliminated' }
		if (run.finishedPvpBlinds.some((done) => done.blindKey === blindKey))
			return { refusal: 'pvp_blind_over' }
		if (run.currentPvpBlind !== null)
			return {
				refusal:
					run.currentPvpBlind.blindKey === blindKey
						? 'pvp_blind_playing'
						: 'wrong_blind',
			}
		// The wire carries a flag; the part works with the named state.
		const mark: 'ready' | 'not ready' = body.ready ? 'ready' : 'not ready'
		if (mark === 'ready') {
			if (blindKey !== `${run.players[player]?.ante}:Boss`)
				return { refusal: 'wrong_blind' }
			if (!playersOfBoss(run, blindKey).includes(player))
				return { refusal: 'not_in_pvp_blind' }
		}
		// Ready is set, not toggled: the mark the run already holds changes nothing, clocks included.
		if ((mark === 'ready') === (run.ready[player] === blindKey)) return state
		const ready = { ...run.ready }
		if (mark === 'ready') ready[player] = blindKey
		else delete ready[player]
		const others = playersOfBoss(run, blindKey).filter((id) => id !== player)
		// Main marks a first Ready only in a game of two.
		const first =
			mark === 'ready' &&
			run.rules.startedCount === 2 &&
			!others.some(
				(id) => run.ready[id] === blindKey || run.firstReady.includes(id),
			) &&
			!run.firstReady.includes(player)
		const marked: State = {
			...state,
			run: {
				...run,
				ready,
				firstReady: first ? [...run.firstReady, player] : run.firstReady,
			},
		}
		// Ready stops the player's personal countdown, and it stays stopped until the PvP blind
		// unless a counting Ante countdown has them as a target; un-ready also pauses the Ante
		// countdown the player started, keeping the time left.
		const own = (countdown: Countdown): boolean =>
			isPersonalFor(countdown, player)
		// Ready also freezes the time left of the player under an Ante countdown (main's
		// ready_blind check); the personal clock's Ante countdown is only a marker.
		const pauseAnteTime = (clocks: Clocks): Clocks =>
			run.rules.clocks.ante === 'personal'
				? clocks
				: pauseForReady(clocks, player, blindKey, now)
		const unready = (frozenClocks: Clocks): Clocks => {
			const clocks = resumeAfterReady(frozenClocks, player, now)
			const stopped = pauseCountdowns(
				setPausedAfter(
					pauseCountdowns(
						clocks,
						(c) => c.kind === 'ante' && c.by === player && isCounting(c),
						now,
					),
					player,
					'paused by starter',
				),
				(c) => own(c) && isCounting(c),
				now,
				'paused until timed',
			)
			const timed = stopped.countdowns.some(
				(c) => c.kind === 'ante' && isCounting(c) && c.against.includes(player),
			)
			// Speedlatro's clock runs again on un-ready (speedlatro_timer.lua).
			return timed || run.rules.clocks.personal?.kind === 'speedlatro'
				? resumeCountdowns(stopped, own, now)
				: stopped
		}
		return changeClocks(marked, (clocks) =>
			mark === 'ready'
				? pauseAnteTime(
						pauseCountdowns(
							clocks,
							(c) => own(c) && isCounting(c),
							now,
							'paused until timed',
						),
					)
				: unready(clocks),
		)
	},
}

export const teamHandler: InputHandler<typeof teamSpec> = {
	spec: teamSpec,
	beforeRun: true,
	handle(state, player, body) {
		if (state.run !== null) return { refusal: 'run_started' }
		// The teams on offer depend on the lobby mode and on how many players are here now, so a
		// pick is checked against both when it arrives; the run's start rules decide what a pick
		// that no longer fits becomes.
		const offered = pickMode(state.lobbyMode, Object.keys(state.players).length)
		if (offered.pickableTeams?.includes(body.team) !== true)
			return { refusal: 'team_not_offered' }
		return {
			...state,
			players: {
				...state.players,
				[player]: { ...state.players[player], team: body.team },
			},
		}
	},
}
