import { describe, expect, it } from 'vitest'
import type { PlayerId, State } from '../core/types'
import { runOutTimers } from '../inputs/timer_run_out'
import { drop, ready, runOf, send } from '../testing/inputs'
import { pairedRun } from '../testing/state'
import { livesOf, start } from '../testing/timers'
import { targetsOf } from './opponent_targets'
import { playersOfBoss } from './players'

const BOSS = '2:Boss'
const HOUR = 3_600_000

const pvpBlindPlayers = (state: State): PlayerId[] =>
	Object.keys(runOf(state).currentPvpBlind?.players ?? {}).sort()

const anteCountdownsAgainst = (state: State, player: PlayerId): number =>
	runOf(state).clocks.countdowns.filter(
		(countdown) =>
			countdown.kind === 'ante' && countdown.against.includes(player),
	).length

// Ann and Cat are a pair, Bob and Dan the other; all are on ante 2.
function fourPlayers(): State {
	return pairedRun(['ann', 'bob', 'cat', 'dan'], {
		ann: 'cat',
		cat: 'ann',
		bob: 'dan',
		dan: 'bob',
	})
}

describe('a Boss that is waiting needs everyone still in', () => {
	it.each(['forfeit', 'left'] as const)(
		'4 players, one is out (%s): the PvP blind opens once the other three are Ready',
		(how) => {
			const waiting = ready(fourPlayers(), 'bob', true, BOSS).state
			expect(playersOfBoss(runOf(waiting), BOSS)).toEqual([
				'ann',
				'bob',
				'cat',
				'dan',
			])
			const dropped = drop(waiting, 'cat', how, 0)
			expect(playersOfBoss(runOf(dropped), BOSS)).toEqual(['ann', 'bob', 'dan'])
			expect(runOf(dropped).currentPvpBlind).toBeNull()
			expect(targetsOf(dropped, 'ann').myBoss).toBe('bye')

			const partial = ready(dropped, 'ann', true, BOSS).state
			expect(runOf(partial).currentPvpBlind).toBeNull()
			const opened = ready(partial, 'dan', true, BOSS).state
			expect(runOf(opened).currentPvpBlind?.blindKey).toBe(BOSS)
			expect(pvpBlindPlayers(opened)).toEqual(['ann', 'bob', 'dan'])
		},
	)

	it.each(['forfeit', 'left'] as const)(
		'an Ante countdown no longer presses a player who is out, the others stay (%s)',
		(how) => {
			const timed = start(
				ready(fourPlayers(), 'ann', true, BOSS).state,
				'ann',
				'ante',
			).state
			expect(anteCountdownsAgainst(timed, 'dan')).toBe(1)
			expect(anteCountdownsAgainst(timed, 'cat')).toBe(1)
			const dropped = drop(timed, 'cat', how, 0)
			expect(anteCountdownsAgainst(dropped, 'dan')).toBe(1)
			expect(livesOf(runOutTimers(dropped, HOUR), 'cat')).toBe(
				livesOf(timed, 'cat'),
			)
		},
	)
})

describe('a playing PvP blind keeps its players', () => {
	it('a partner who forfeits before I entered the blind leaves me in the PvP blind, compared with no one', () => {
		const playing = ['ann', 'bob', 'cat', 'dan'].reduce(
			(next, player) => ready(next, player, true, BOSS).state,
			fourPlayers(),
		)
		expect(pvpBlindPlayers(playing)).toEqual(['ann', 'bob', 'cat', 'dan'])
		const dropped = drop(playing, 'cat', 'forfeit', 0)
		expect(targetsOf(dropped, 'ann').myBoss).toBe('bye')
		expect(pvpBlindPlayers(dropped)).toContain('ann')

		let next = dropped
		next = send(next, 'ann', {
			kind: 'blindStart',
			blindKey: BOSS,
			handsLeft: 1,
			score: '100',
		}).state
		next = send(next, 'ann', {
			kind: 'handScored',
			blindKey: BOSS,
			handsLeft: 0,
			score: '100',
		}).state
		expect(runOf(next).currentPvpBlind).not.toBeNull()
	})
})
