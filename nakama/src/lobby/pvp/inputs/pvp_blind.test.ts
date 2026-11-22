import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { tick } from '../core/tick'
import {
	BLIND,
	endedByOf,
	entryOf,
	handsLeftInPvpBlind,
	ready,
	runOf,
	scoreInPvpBlind,
	send,
} from '../testing/inputs'
import {
	LIMITS,
	pairedRun,
	reportedRunInMode as runInMode,
	reportedRunState as runState,
} from '../testing/state'

import type { PvpLimits, State } from '../core/types'
import { playersOfBoss, requiredPlayers } from '../rules/players'
import { handsLeftOf, scoreOf } from '../rules/pvp_blind_rules'
import {
	endPvpBlindFor,
	openPvpBlindIfReady,
	pvpBlindView,
	settlePvpBlind,
} from './pvp_blind'

const PLAYERS = ['ann', 'bob']

function playingPvpBlind(
	players: string[] = PLAYERS,
	limits: PvpLimits = LIMITS,
	mode: 'nemesis' | 'royale' = 'nemesis',
): State {
	const base = runState(players, limits)
	let state: State = {
		...base,
		run: {
			...runOf(base),
			rules: { ...runOf(base).rules, mode, startedCount: players.length },
		},
	}
	for (const player of players) state = ready(state, player).state
	return state
}

const body = (kind: string, fields: object) => ({
	kind,
	blindKey: BLIND,
	...fields,
})
const start = (hands: number, score: string) =>
	body('blindStart', { handsLeft: hands, score })
const played = (hands: number) => body('handPlayed', { handsLeft: hands })
const scored = (hands: number, score: string) =>
	body('handScored', { handsLeft: hands, score })

function playingPlayers(state: State, viewer: string) {
	const view = pvpBlindView(state, viewer)
	if (view?.stage !== 'playing') throw new Error('no PvP blind is playing')
	return view.players
}

describe('PvP blind inputs', () => {
	it('blindStart stores hands and score, once per player per PvP blind', () => {
		let state = playingPvpBlind()
		state = send(state, 'ann', start(4, '0')).state
		expect(entryOf(state, 'ann')).toMatchObject({
			stage: 'entered',
			handsLeft: 4,
			score: '0',
		})
		const again = send(state, 'ann', start(3, '5'))
		expect(again.refusals).toEqual(['already_started'])
		expect(again.state.run).toEqual(state.run)
	})

	it('a played hand is scoring until its score comes, then played', () => {
		let state = send(playingPvpBlind(), 'ann', start(4, '0')).state
		state = send(state, 'ann', played(3)).state
		expect(entryOf(state, 'ann')).toEqual({
			stage: 'scoring a hand',
			handsLeft: 3,
			score: '0',
		})
		expect(playingPlayers(state, 'bob').ann).toMatchObject({
			stage: 'scoring a hand',
			handsLeft: 3,
		})
		state = send(state, 'ann', scored(3, '120')).state
		expect(entryOf(state, 'ann')).toEqual({
			stage: 'played a hand',
			handsLeft: 3,
			score: '120',
		})
	})

	it('hands_left_is_last_reported: absent before blindStart, never 0', () => {
		let state = playingPvpBlind()
		expect(handsLeftInPvpBlind(state, 'ann')).toBeNull()
		expect(pvpBlindView(state, 'bob')?.players.ann).not.toHaveProperty(
			'handsLeft',
		)
		state = send(state, 'ann', start(4, '0')).state
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 8 }),
				(reports) => {
					let next = state
					for (const hands of reports) {
						const result = send(next, 'ann', played(hands))
						expect(result.refusals).toEqual([])
						next = result.state
						expect(handsLeftInPvpBlind(next, 'ann')).toBe(hands)
					}
				},
			),
		)
	})

	it.each([
		['hand played before the blind start', played(2), 'not_started'],
		['a hand scored before the blind start', scored(2, '5'), 'not_started'],
		['another blind', { ...start(4, '0'), blindKey: '3:Boss' }, 'wrong_blind'],
	])('refuses %s', (_name, input, code) => {
		const before = playingPvpBlind()
		const { state, refusals, lastNumber } = send(before, 'ann', input)
		expect(refusals).toEqual([code])
		expect(state.run).toEqual(before.run)
		expect(lastNumber).toBe(1)
	})

	it('refuses a PvP blind input while the PvP blind is only waiting or absent', () => {
		const waiting = ready(runState(PLAYERS), 'ann').state
		expect(send(waiting, 'ann', start(4, '0')).refusals).toEqual([
			'no_pvp_blind',
		])
		expect(send(runState(PLAYERS), 'ann', start(4, '0')).refusals).toEqual([
			'no_pvp_blind',
		])
	})

	it('refuses hands outside 0..100 and a score that is not score text', () => {
		const state = playingPvpBlind()
		expect(send(state, 'ann', start(101, '0')).refusals).toEqual([
			'bad_request_body',
		])
		expect(send(state, 'ann', start(-1, '0')).refusals).toEqual([
			'bad_request_body',
		])
		expect(send(state, 'ann', start(4, 'lots')).refusals).toEqual([
			'bad_request_body',
		])
	})

	it('a lower score is taken as stated and the last hand still ends the blind', () => {
		let state = send(playingPvpBlind(), 'ann', start(2, '10')).state
		state = send(state, 'ann', played(1)).state
		state = send(state, 'ann', scored(1, '20')).state
		state = send(state, 'ann', played(0)).state
		const last = send(state, 'ann', scored(0, '19'))
		expect(last.refusals).toEqual([])
		expect(entryOf(last.state, 'ann')).toMatchObject({
			stage: 'done',
			handsLeft: 0,
			score: '19',
		})
	})

	describe('hands gained mid-blind', () => {
		const pvpBlindAfter = (
			...inputs: { [field: string]: unknown }[]
		): State => {
			let state = send(playingPvpBlind(), 'ann', start(4, '0')).state
			for (const input of inputs) {
				const result = send(state, 'ann', input)
				expect(result.refusals).toEqual([])
				state = result.state
			}
			return state
		}

		it.each([
			[
				'an extra hand after hand 1',
				[played(3), scored(3, '10'), played(4), scored(4, '25')],
				{ handsLeft: 4, score: '25', ended: false },
			],
			[
				'an extra hand on the last hand',
				[
					played(3),
					scored(3, '10'),
					played(2),
					scored(2, '20'),
					played(1),
					scored(1, '30'),
					played(2),
					scored(2, '45'),
				],
				{ handsLeft: 2, score: '45', ended: false },
			],
			[
				'two extra hands',
				[
					played(3),
					scored(3, '10'),
					played(4),
					scored(4, '20'),
					played(5),
					scored(5, '30'),
				],
				{ handsLeft: 5, score: '30', ended: false },
			],
			[
				'the extra hand played out to 0',
				[
					played(3),
					scored(3, '10'),
					played(4),
					scored(4, '15'),
					played(2),
					scored(2, '20'),
					played(1),
					scored(1, '25'),
					played(0),
					scored(0, '30'),
				],
				{ handsLeft: 0, score: '30', ended: true },
			],
		])('%s', (_name, inputs, expected) => {
			const own = entryOf(pvpBlindAfter(...inputs), 'ann')
			expect(handsLeftOf(own)).toBe(expected.handsLeft)
			expect(scoreOf(own)).toBe(expected.score)
			expect(own.stage === 'done').toBe(expected.ended)
		})

		it('an older input arriving late changes nothing', () => {
			const state = pvpBlindAfter(
				played(3),
				scored(3, '10'),
				played(4),
				scored(4, '20'),
			)
			const older = send(
				state,
				'ann',
				{ ...scored(3, '10'), messageNumber: 1 },
				0,
				4,
			)
			expect(older.refusals).toEqual([])
			expect(older.state).toEqual(state)
		})
	})

	const inputKinds: { [field: string]: unknown }[] = [
		played(3),
		scored(3, '10'),
		played(4),
		scored(4, '20'),
		played(2),
		scored(2, '35'),
	]

	it('delivering any input twice changes nothing', () => {
		fc.assert(
			fc.property(fc.subarray(inputKinds, { minLength: 1 }), (inputs) => {
				let state = send(playingPvpBlind(), 'ann', start(4, '0')).state
				for (const input of inputs) {
					const once = send(state, 'ann', input)
					const twice = send(once.state, 'ann', input, 0, once.lastNumber)
					expect(twice.refusals).toEqual([])
					expect(twice.state).toEqual(once.state)
					state = once.state
				}
			}),
		)
	})

	it('the stored score is the latest accepted score', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 10 }),
				fc.array(fc.integer({ min: 1, max: 6 }), {
					minLength: 10,
					maxLength: 10,
				}),
				(scores, hands) => {
					let state = send(playingPvpBlind(), 'ann', start(4, '0')).state
					let latest = '0'
					scores.forEach((score, index) => {
						const result = send(
							state,
							'ann',
							scored(hands[index], String(score)),
						)
						if (result.refusals.length === 0) latest = String(score)
						state = result.state
						expect(scoreInPvpBlind(state, 'ann')).toBe(latest)
					})
				},
			),
		)
	})

	it('last_hand_resend_ends_pvp_blind', () => {
		let state = send(playingPvpBlind(), 'ann', start(1, '10')).state
		state = send(state, 'bob', start(2, '5')).state
		state = send(state, 'ann', played(0)).state
		expect(entryOf(state, 'ann')).toMatchObject({
			stage: 'scoring a hand',
			handsLeft: 0,
		})
		state = send(state, 'ann', scored(0, '10')).state
		expect(endedByOf(state, 'ann')).toBe('hands')
		state = send(state, 'bob', scored(0, '5')).state
		const run = runOf(state)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			scores: { ann: '10', bob: '5' },
		})
	})

	it('refuses a PvP blind input from a player who is done', () => {
		let state = send(playingPvpBlind(), 'ann', start(1, '10')).state
		state = send(state, 'ann', scored(0, '10')).state
		const refused = send(state, 'ann', played(0))
		expect(refused.refusals).toEqual(['pvp_blind_done'])
	})

	it('one_pvp_blind_per_blind_key: a resolved blind cannot be opened again', () => {
		let state = send(playingPvpBlind(), 'ann', start(0, '10')).state
		state = send(state, 'bob', start(0, '5')).state
		state = send(state, 'ann', scored(0, '10')).state
		state = send(state, 'bob', scored(0, '5')).state
		expect(runOf(state).finishedPvpBlinds).toHaveLength(1)
		expect(ready(state, 'ann').refusals).toEqual(['pvp_blind_over'])
		expect(runOf(ready(state, 'ann').state).currentPvpBlind).toBeNull()
	})
})

describe('endPvpBlindFor', () => {
	it('end_pvp_blind_for_done_player_changes_nothing', () => {
		const reasons = fc.constantFrom('hands', 'timer' as const)
		fc.assert(
			fc.property(reasons, reasons, (first, second) => {
				const done = endPvpBlindFor(playingPvpBlind(), 'ann', first)
				expect(endedByOf(done, 'ann')).toBe(first)
				expect(endPvpBlindFor(done, 'ann', second)).toBe(done)
			}),
		)
	})

	it('a player outside the PvP blind changes nothing', () => {
		const state = playingPvpBlind()
		expect(endPvpBlindFor(state, 'zed', 'timer')).toBe(state)
	})
})

describe('resolving', () => {
	it('pvp_timer_out_loses_pvp_blind_two_players: a timer end resolves at once, that player loses whatever the scores', () => {
		let state = send(playingPvpBlind(), 'ann', start(3, '1')).state
		state = send(state, 'bob', start(3, '9999')).state
		state = settlePvpBlind(endPvpBlindFor(state, 'bob', 'timer'), 10)
		const run = runOf(state)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds[0]).toMatchObject({
			losers: ['bob'],
			endedBy: { bob: 'timer' },
			scores: { ann: '1', bob: '9999' },
			livesAfter: { ann: 4, bob: 3 },
		})
		expect(run.finishedPvpBlinds[0].endedBy).not.toHaveProperty('ann')
	})

	it('pvp_timer_out_only_that_player_three_or_more: the PvP blind stays playing and the timed-out player loses with their score kept', () => {
		const three = ['ann', 'bob', 'cat']
		let state = playingPvpBlind(three, LIMITS, 'royale')
		for (const [player, score] of [
			['ann', '10'],
			['bob', '20'],
			['cat', '9999'],
		] as const)
			state = send(state, player, start(3, score)).state
		state = settlePvpBlind(endPvpBlindFor(state, 'cat', 'timer'), 10)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(endedByOf(state, 'cat')).toBe('timer')
		expect(endedByOf(state, 'ann')).toBeNull()
		state = send(state, 'ann', scored(0, '10')).state
		state = send(state, 'bob', scored(0, '20')).state
		const result = runOf(state).finishedPvpBlinds[0]
		expect(result.losers).toContain('cat')
		expect(result.scores.cat).toBe('9999')
	})

	it('left_player_is_not_required: the PvP blind resolves when the others are done', () => {
		const three = ['ann', 'bob', 'cat']
		let state = playingPvpBlind(three, LIMITS, 'royale')
		for (const [player, score] of [
			['ann', '10'],
			['bob', '20'],
			['cat', '30'],
		] as const)
			state = send(state, player, start(1, score)).state
		state = send(state, 'ann', scored(0, '10')).state
		state = send(state, 'bob', scored(0, '20')).state
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		const run = runOf(state)
		state = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, cat: { ...run.lives.cat, status: 'left' } },
			},
		}
		expect(requiredPlayers(runOf(state)).sort()).toEqual(['ann', 'bob'])
		state = settlePvpBlind(state, 5)
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect(runOf(state).finishedPvpBlinds[0].losers).toEqual(['ann'])
	})

	it('a PvP blind that is waiting opens once the player who has not readied leaves', () => {
		const base = runInMode(['ann', 'bob', 'cat'], 'royale')
		let state = ready(ready(base, 'ann').state, 'bob').state
		expect(runOf(state).currentPvpBlind).toBeNull()
		const run = runOf(state)
		state = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, cat: { ...run.lives.cat, status: 'left' } },
			},
		}
		expect(runOf(openPvpBlindIfReady(state, 5)).currentPvpBlind).not.toBeNull()
	})
})

describe('no idle limit', () => {
	it('a player who played their last hand keeps the PvP blind open until its score is reported', () => {
		let state = playingPvpBlind()
		state = send(state, 'ann', start(1, '5'), 0).state
		state = send(state, 'bob', start(1, '9'), 0).state
		state = send(state, 'bob', scored(0, '9'), 1000).state
		state = send(state, 'ann', played(0), 2000).state
		expect(endedByOf(state, 'bob')).toBe('hands')
		expect(endedByOf(state, 'ann')).toBeNull()
		for (const now of [180_000, 10 * 180_000]) {
			const ticked = tick(state, now, { ranked: true })
			expect(ticked).toBe(state)
			expect(runOf(ticked).currentPvpBlind).not.toBeNull()
		}
		state = send(state, 'ann', scored(0, '5'), 2_000_000).state
		const run = runOf(state)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds[0].losers).toEqual(['ann'])
		expect(run.finishedPvpBlinds[0].scores).toEqual({ ann: '5', bob: '9' })
	})
})

describe('the animating budget', () => {
	it('starts full at every PvP blind', () => {
		const base = runState(PLAYERS)
		const run = runOf(base)
		let state: State = {
			...base,
			run: {
				...run,
				clocks: {
					...run.clocks,
					players: {
						...run.clocks.players,
						ann: {
							...run.clocks.players.ann,
							animatingBlindLeftMilliseconds: 1000,
						},
					},
				},
			},
		}
		for (const player of PLAYERS) state = ready(state, player).state
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(runOf(state).clocks.players.ann.animatingBlindLeftMilliseconds).toBe(
			LIMITS.animatingBlindMilliseconds,
		)
	})
})

describe('a paired PvP blind', () => {
	const THREE = ['ann', 'bob', 'cat']
	const withBye = (): State =>
		pairedRun(THREE, { ann: 'bob', bob: 'ann', cat: null })
	const FOUR = ['ann', 'bob', 'cat', 'dan']
	const twoPairs = (): State =>
		pairedRun(FOUR, { ann: 'bob', bob: 'ann', cat: 'dan', dan: 'cat' })

	it('is everyone: the bye plays too, and the PvP blind waits on them', () => {
		let state = ready(ready(withBye(), 'ann').state, 'bob').state
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect(playersOfBoss(runOf(state), BLIND).sort()).toEqual(THREE)
		state = ready(state, 'cat').state
		expect(requiredPlayers(runOf(state)).sort()).toEqual(THREE)
		expect(ready(state, 'cat').refusals).toEqual(['pvp_blind_playing'])
		for (const [player, hands, score] of [
			['ann', 1, '1'],
			['bob', 1, '9'],
			['cat', 1, '5'],
		] as const)
			state = send(state, player, start(hands, score)).state
		state = send(state, 'ann', scored(0, '1')).state
		state = send(state, 'bob', scored(0, '9')).state
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		state = send(state, 'cat', scored(0, '5')).state
		const run = runOf(state)
		expect(run.currentPvpBlind).toBeNull()
		expect(run.finishedPvpBlinds[0]).toMatchObject({
			losers: ['ann'],
			livesAfter: { ann: 3, bob: 4, cat: 4 },
			teamScores: null,
		})
	})

	it('each pair loses its lower score: two pairs, two losers, one life each', () => {
		let state = twoPairs()
		for (const player of FOUR) state = ready(state, player).state
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		const scores = { ann: '1', bob: '5', cat: '9', dan: '3' }
		for (const player of FOUR)
			state = send(
				state,
				player,
				start(1, scores[player as keyof typeof scores]),
			).state
		for (const player of FOUR)
			state = send(
				state,
				player,
				scored(0, scores[player as keyof typeof scores]),
			).state
		const result = runOf(state).finishedPvpBlinds[0]
		expect(result.losers).toEqual(['ann', 'dan'])
		expect(result.livesAfter).toEqual({ ann: 3, bob: 4, cat: 4, dan: 3 })
	})

	it('conserves lives: one life lost per pair at most, however many players', () => {
		const score = fc.nat({ max: 10_000 }).map(String)
		fc.assert(
			fc.property(fc.array(score, { minLength: 4, maxLength: 4 }), (posted) => {
				let state = twoPairs()
				for (const player of FOUR) state = ready(state, player).state
				FOUR.forEach((player, index) => {
					state = send(state, player, start(0, posted[index])).state
					state = send(state, player, scored(0, posted[index])).state
				})
				const run = runOf(state)
				expect(run.currentPvpBlind).toBeNull()
				const total = Object.values(run.lives).reduce(
					(sum, own) => sum + own.lives,
					0,
				)
				expect(16 - total).toBe(run.finishedPvpBlinds[0].losers.length)
				expect(run.finishedPvpBlinds[0].losers.length).toBeLessThanOrEqual(2)
			}),
		)
	})
})

describe('closing a PvP blind', () => {
	it('endPvpBlindFor changes nothing unless the PvP blind is playing', () => {
		const waiting = ready(runState(PLAYERS), 'ann').state
		expect(runOf(waiting).currentPvpBlind).toBeNull()
		expect(endPvpBlindFor(waiting, 'ann', 'timer')).toBe(waiting)
		const none = runState(PLAYERS)
		expect(endPvpBlindFor(none, 'ann', 'timer')).toBe(none)
	})
})

describe('pvpBlindView', () => {
	const SECRET = '424242'

	it('hides the others score until the viewer plays a hand or is done', () => {
		let state = send(playingPvpBlind(), 'bob', start(3, SECRET)).state
		state = send(state, 'ann', start(3, '1')).state
		const before = playingPlayers(state, 'ann')
		expect(before.bob).toMatchObject({ score: { kind: 'hidden' } })
		expect(JSON.stringify(before)).not.toContain(SECRET)
		expect(before.ann).toMatchObject({ score: { kind: 'shown', score: '1' } })
		state = send(state, 'ann', played(2)).state
		expect(playingPlayers(state, 'ann').bob).toMatchObject({
			score: { kind: 'shown', score: SECRET },
		})
	})

	it('shows a player with no score as not hidden', () => {
		expect(playingPlayers(playingPvpBlind(), 'ann').bob).toEqual({
			stage: 'not entered',
		})
	})

	it('a finished player sees every score; a waiting PvP blind hides none', () => {
		let state = send(playingPvpBlind(), 'bob', start(3, SECRET)).state
		state = endPvpBlindFor(state, 'ann', 'timer')
		expect(playingPlayers(state, 'ann').bob).toMatchObject({
			score: { kind: 'shown', score: SECRET },
		})
		expect(playingPlayers(state, 'ann').ann).toMatchObject({
			stage: 'done',
			endedBy: 'timer',
		})
	})

	it('is null with no open PvP blind', () => {
		expect(pvpBlindView(runState(PLAYERS), 'ann')).toBeNull()
	})

	it('view_never_leaks_hidden_fields: no opponent score text in the view of a player who has not played a hand', () => {
		// Each player's scores live in their own range, so a score text names its owner.
		const base = { ann: 1_000_000, bob: 2_000_000 } as const
		const step = fc.record({
			player: fc.constantFrom(...PLAYERS),
			kind: fc.constantFrom('blindStart', 'handPlayed', 'handScored'),
			hands: fc.integer({ min: 0, max: 3 }),
			bump: fc.nat({ max: 999 }),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 14 }), (steps) => {
				let state = playingPvpBlind()
				const looked = new Set<string>()
				const posted: { [player: string]: Set<string> } = {
					ann: new Set(),
					bob: new Set(),
				}
				for (const { player, kind, hands, bump } of steps) {
					const score = String(base[player as keyof typeof base] + bump)
					const fields =
						kind === 'handPlayed'
							? { handsLeft: hands }
							: { handsLeft: hands, score }
					const result = send(state, player, body(kind, fields))
					state = result.state
					if (result.refusals.length === 0) {
						if (kind !== 'blindStart') looked.add(player)
						if (kind !== 'handPlayed') posted[player].add(score)
					}
					for (const viewer of PLAYERS) {
						const other = PLAYERS.find((p) => p !== viewer) as string
						const text = JSON.stringify(pvpBlindView(state, viewer))
						if (looked.has(viewer)) continue
						if (entryOfOrNull(state, viewer)?.stage === 'done') continue
						for (const secret of posted[other])
							expect(text).not.toContain(`"${secret}"`)
					}
				}
			}),
		)
	})
})

function entryOfOrNull(state: State, player: string) {
	return state.run?.currentPvpBlind?.players[player] ?? null
}

function readyAll(base: State, players: string[]): State {
	let state = base
	for (const player of players) state = ready(state, player).state
	return state
}

// Every player reports one hand at their score, then plays it.
function finishAll(state: State, scores: { [player: string]: string }): State {
	let next = state
	for (const player of Object.keys(scores))
		next = send(next, player, start(1, scores[player])).state
	for (const player of Object.keys(scores))
		next = send(next, player, scored(0, scores[player])).state
	return next
}

describe('what a PvP blind costs', () => {
	it('handScored with hands left keeps the player playing; with none left it ends them', () => {
		let state = send(playingPvpBlind(), 'ann', start(2, '1')).state
		state = send(state, 'ann', scored(1, '5')).state
		expect(endedByOf(state, 'ann')).toBeNull()
		state = send(state, 'ann', scored(0, '7')).state
		expect(endedByOf(state, 'ann')).toBe('hands')
	})

	it('the life is written to the ledger as pvp:<PvP blind number>', () => {
		const state = finishAll(playingPvpBlind(), { ann: '1', bob: '9' })
		expect(runOf(state).lives.ann.events).toEqual([
			{ delta: -1, cause: 'pvp:1' },
		])
		expect(runOf(state).lives.bob.events).toEqual([])
	})

	it('royale with four players: every player below the cut loses a life', () => {
		const four = ['ann', 'bob', 'cat', 'dan']
		const state = finishAll(readyAll(runInMode(four, 'royale'), four), {
			ann: '10',
			bob: '20',
			cat: '30',
			dan: '40',
		})
		const result = runOf(state).finishedPvpBlinds[0]
		expect(result.losers.length).toBeGreaterThanOrEqual(2)
		for (const player of four)
			expect(result.livesAfter[player]).toBe(
				result.losers.includes(player) ? 3 : 4,
			)
	})

	it('teams: the losing team pays one life from its pool, however many members lose', () => {
		const four = ['ann', 'bob', 'cat', 'dan']
		const base = runInMode(four, 'teams', {
			ann: 'A',
			bob: 'A',
			cat: 'B',
			dan: 'B',
		})
		const withPool: State = {
			...base,
			run: { ...runOf(base), teamLives: { A: 4, B: 4 } },
		}
		const state = finishAll(readyAll(withPool, four), {
			ann: '1',
			bob: '1',
			cat: '50',
			dan: '50',
		})
		const run = runOf(state)
		expect(run.finishedPvpBlinds[0].losers.sort()).toEqual(['ann', 'bob'])
		// A rejoin after the close still reads both team totals from the closed entry.
		expect(run.finishedPvpBlinds[0].teamScores).toEqual({ A: '2', B: '100' })
		expect(run.teamLives).toEqual({ A: 3, B: 4 })
		expect(run.lives.ann.lives).toBe(3)
		expect(run.lives.bob.lives).toBe(3)
		expect(run.lives.cat.lives).toBe(4)
	})

	it('three players: a timer end does not close the PvP blind', () => {
		const three = ['ann', 'bob', 'cat']
		let state = playingPvpBlind(three, LIMITS, 'royale')
		state = send(state, 'ann', start(3, '1')).state
		state = settlePvpBlind(endPvpBlindFor(state, 'ann', 'timer'), 10)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(runOf(state).finishedPvpBlinds).toEqual([])
	})

	const lifeTotal = (state: State): number =>
		Object.values(runOf(state).lives).reduce((sum, seat) => sum + seat.lives, 0)

	it('lives_change_only_through_rules: only a closed PvP blind takes lives', () => {
		const names = ['ann', 'bob', 'cat']
		const step = fc.record({
			player: fc.constantFrom(...names),
			kind: fc.constantFrom('blindStart', 'handPlayed', 'handScored'),
			hands: fc.integer({ min: 0, max: 3 }),
			score: fc.nat({ max: 1000 }),
		})
		fc.assert(
			fc.property(
				fc.constantFrom('royale', 'nemesis'),
				fc.array(step, { maxLength: 16 }),
				(mode, steps) => {
					let state = playingPvpBlind(names, LIMITS, mode)
					for (const { player, kind, hands, score } of steps) {
						const before = lifeTotal(state)
						const finishedPvpBlinds = runOf(state).finishedPvpBlinds.length
						const fields =
							kind === 'handPlayed'
								? { handsLeft: hands }
								: { handsLeft: hands, score: String(score) }
						state = send(state, player, body(kind, fields)).state
						const after = runOf(state)
						if (after.finishedPvpBlinds.length === finishedPvpBlinds)
							expect(lifeTotal(state)).toBe(before)
						else {
							const lost = before - lifeTotal(state)
							expect(lost).toBe(
								after.finishedPvpBlinds[finishedPvpBlinds].losers.length,
							)
						}
					}
				},
			),
		)
	})
})

const onAnte2 = (state: State): State =>
	PLAYERS.reduce(
		(next, player) =>
			send(next, player, { kind: 'progress', ante: 2, location: 'shop' }).state,
		state,
	)

describe('pvpBlindView of a waiting PvP blind', () => {
	it('hides nothing and says waiting', () => {
		const base = runInMode(PLAYERS, 'royale')
		const state = ready(base, 'ann').state
		const view = pvpBlindView(onAnte2(state), 'bob')
		expect(view).toEqual({
			stage: 'waiting',
			blindKey: BLIND,
			players: { ann: 'ready', bob: 'not ready' },
		})
	})
})
