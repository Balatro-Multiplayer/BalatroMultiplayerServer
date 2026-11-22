import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EndedBy, PvpBlindPlayer, State } from '../core/types'
import { settlePvpBlind as resolvePvpBlind } from '../inputs/pvp_blind'
import { BLIND } from '../testing/inputs'
import { runState } from '../testing/state'
import { isPvpBlind } from './players'
import { mayLookAtScores } from './pvp_blind_rules'

type Posted = { score: string | null; endedBy: EndedBy | null }

function playerOf({ score, endedBy }: Posted): PvpBlindPlayer {
	if (endedBy !== null) return { stage: 'done', endedBy, handsLeft: 0, score }
	if (score !== null) return { stage: 'played a hand', handsLeft: 1, score }
	return { stage: 'not entered' }
}

// A playing PvP blind of the given players, each with what it has posted.
function playing(
	posted: { [player: string]: Posted },
	mode = 'nemesis',
): State {
	const players = Object.keys(posted)
	const base = runState(players)
	const run = base.run
	if (run === null) throw new Error('no run')
	const currentPvpBlind: { [player: string]: PvpBlindPlayer } = {}
	for (const player of players)
		currentPvpBlind[player] = playerOf(posted[player])
	return {
		...base,
		run: {
			...run,
			rules: {
				...run.rules,
				mode: mode as 'nemesis',
				startedCount: players.length,
			},
			currentPvpBlind: {
				blindKey: BLIND,
				players: currentPvpBlind,
				banks: {},
			},
		},
	}
}

const lifeTotal = (state: State): number =>
	Object.values(state.run?.lives ?? {}).reduce((sum, own) => sum + own.lives, 0)

describe('isPvpBlind', () => {
	const run = runState(['ann', 'bob']).run
	it.each([
		['2:Boss', true],
		['5:Boss', true],
		['1:Boss', false],
		['2:Small', false],
		['2:Big', false],
		['Boss', false],
		['', false],
	])('%s -> %s', (blindKey, expected) => {
		if (run === null) throw new Error('no run')
		expect(isPvpBlind(run, blindKey)).toBe(expected)
	})
})

describe('resolvePvpBlind', () => {
	it('waits while a required player is not done', () => {
		const state = playing({
			ann: { score: '100', endedBy: 'hands' },
			bob: { score: '50', endedBy: null },
		})
		expect(resolvePvpBlind(state, 0)).toBe(state)
	})

	it('takes one life from the lower score and closes the PvP blind', () => {
		const state = playing({
			ann: { score: '100', endedBy: 'hands' },
			bob: { score: '50', endedBy: 'hands' },
		})
		const next = resolvePvpBlind(state, 0)
		expect(next.run?.currentPvpBlind).toBeNull()
		expect(next.run?.finishedPvpBlinds).toEqual([
			{
				blindKey: BLIND,
				scores: { ann: '100', bob: '50' },
				endedBy: { ann: 'hands', bob: 'hands' },
				losers: ['bob'],
				livesAfter: { ann: 4, bob: 3 },
				teamScores: null,
			},
		])
	})

	it('in a two-player PvP blind, a timer end loses whatever the scores', () => {
		const state = playing({
			ann: { score: '1', endedBy: null },
			bob: { score: '9999', endedBy: 'timer' },
		})
		const next = resolvePvpBlind(state, 0)
		expect(next.run?.finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			scores: { ann: '1', bob: '9999' },
			livesAfter: { ann: 4, bob: 3 },
		})
	})

	it('with three players, a timer end loses with the score kept and the PvP blind waits for the rest', () => {
		const waiting = playing(
			{
				ann: { score: '10', endedBy: null },
				bob: { score: '20', endedBy: null },
				cat: { score: '9999', endedBy: 'timer' },
			},
			'royale',
		)
		expect(resolvePvpBlind(waiting, 0)).toBe(waiting)
		const done = playing(
			{
				ann: { score: '10', endedBy: 'hands' },
				bob: { score: '20', endedBy: 'hands' },
				cat: { score: '9999', endedBy: 'timer' },
			},
			'royale',
		)
		const next = resolvePvpBlind(done, 0)
		expect(next.run?.finishedPvpBlinds[0].losers).toContain('cat')
	})

	it('a player with no blindStart has no score and ranks last', () => {
		const state = playing({
			ann: { score: '5', endedBy: 'hands' },
			bob: { score: null, endedBy: 'timer' },
		})
		const next = resolvePvpBlind(state, 0)
		expect(next.run?.finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			scores: { ann: '5', bob: null },
			endedBy: { ann: 'hands', bob: 'timer' },
		})
	})

	it('does nothing when there is no PvP blind', () => {
		const state = playing({
			ann: { score: '1', endedBy: 'hands' },
			bob: { score: '2', endedBy: 'hands' },
		})
		const run = state.run
		if (run === null) throw new Error('no run')
		const none = { ...state, run: { ...run, currentPvpBlind: null } }
		expect(resolvePvpBlind(none, 0)).toBe(none)
	})

	it('conserves lives: at most one life per resolved two-player PvP blind', () => {
		const score = fc.nat({ max: 10_000 }).map(String)
		fc.assert(
			fc.property(score, score, (left, right) => {
				const state = playing({
					ann: { score: left, endedBy: 'hands' },
					bob: { score: right, endedBy: 'hands' },
				})
				const next = resolvePvpBlind(state, 0)
				expect(next.run?.currentPvpBlind).toBeNull()
				const lost = lifeTotal(state) - lifeTotal(next)
				expect(lost).toBe(next.run?.finishedPvpBlinds[0].losers.length)
				expect(lost).toBeLessThanOrEqual(1)
				expect(resolvePvpBlind(next, 0)).toBe(next)
			}),
		)
	})
})

describe('who a closed PvP blind names as losers', () => {
	it('names the trailing player when the PvP blind is played out', () => {
		const lost = resolvePvpBlind(
			playing({
				ann: { score: '100', endedBy: 'hands' },
				bob: { score: '50', endedBy: 'hands' },
			}),
			0,
		)
		expect(lost.run?.finishedPvpBlinds[0].losers).toEqual(['bob'])
	})

	it('names a player the timer ended even when the score was higher', () => {
		const timed = resolvePvpBlind(
			playing({
				ann: { score: '1', endedBy: null },
				bob: { score: '9', endedBy: 'timer' },
			}),
			0,
		)
		expect(timed.run?.finishedPvpBlinds[0].losers).toEqual(['bob'])
	})
})

describe('mayLookAtScores', () => {
	const currentPvpBlind = (own: PvpBlindPlayer) => {
		const base = playing({
			ann: { score: '1', endedBy: null },
			bob: { score: '2', endedBy: null },
		}).run?.currentPvpBlind
		if (!base) throw new Error('no PvP blind')
		return { ...base, players: { ...base.players, ann: own } }
	}

	it.each<[string, PvpBlindPlayer, boolean]>([
		['nothing played', { stage: 'not entered' }, false],
		['entered', { stage: 'entered', handsLeft: 4, score: '0' }, false],
		[
			'a hand played',
			{ stage: 'played a hand', handsLeft: 3, score: '1' },
			true,
		],
		[
			'finished',
			{ stage: 'done', endedBy: 'hands', handsLeft: 0, score: '1' },
			true,
		],
	])('%s -> %s', (_name, own, expected) => {
		expect(mayLookAtScores(currentPvpBlind(own), 'ann')).toBe(expected)
	})

	it('a player who is not in the PvP blind sees nothing while it plays', () => {
		expect(
			mayLookAtScores(currentPvpBlind({ stage: 'not entered' }), 'zed'),
		).toBe(false)
	})
})
