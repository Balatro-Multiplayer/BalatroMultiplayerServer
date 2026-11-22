import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { State } from '../core/types'
import { runOf, send } from '../testing/inputs'
import { runState } from '../testing/state'

const DUEL = ['ann', 'bob']

function atFirstAnte(players: string[]): State {
	return players.reduce(
		(state, player) =>
			send(state, player, { kind: 'progress', ante: 1, location: 'shop' })
				.state,
		runState(players),
	)
}

const play = (effect: string, total: number) => ({
	kind: 'effect',
	effect,
	total,
})
const itemsOf = (state: State, player: string, effect: string): number[] =>
	runOf(state)
		.players[player].inbox.filter((item) => item.effect === effect)
		.map((item) => item.amount)

describe('effect', () => {
	it.each([
		['asteroid', 1],
		['pizza', 1],
		['gambling', 10],
	])('%s gives the opponent one item of %i per play', (effect, amount) => {
		const state = send(atFirstAnte(DUEL), 'ann', play(effect, 2)).state
		expect(itemsOf(state, 'bob', effect)).toEqual([amount, amount])
		expect(runOf(state).players.ann.inbox).toEqual([])
	})

	it('a Pizza carries the ante its sender was at; other effects carry none', () => {
		let state = atFirstAnte(DUEL)
		state = send(state, 'ann', {
			kind: 'progress',
			ante: 3,
			location: 'shop',
		}).state
		state = send(state, 'ann', play('pizza', 1)).state
		state = send(state, 'ann', play('gambling', 1)).state
		expect(
			runOf(state).players.bob.inbox.map((item) =>
				item.effect === 'pizza' ? item.ante : undefined,
			),
		).toEqual([3, undefined])
		expect(
			runOf(state).players.bob.inbox.map((item) => 'ante' in item),
		).toEqual([true, false])
	})

	it('effect_redo_after_crash_hits_once: the same total sent again adds nothing', () => {
		let state = send(atFirstAnte(DUEL), 'ann', play('pizza', 1)).state
		state = send(state, 'ann', play('pizza', 1)).state
		expect(itemsOf(state, 'bob', 'pizza')).toEqual([1])
		state = send(state, 'ann', play('pizza', 3)).state
		expect(itemsOf(state, 'bob', 'pizza')).toEqual([1, 1, 1])
	})

	it('pizza and gambling reach every other player, asteroid only those facing the player', () => {
		const four = ['ann', 'bob', 'cy', 'di']
		const pizza = send(atFirstAnte(four), 'ann', play('pizza', 1)).state
		expect(
			['bob', 'cy', 'di'].map((id) => itemsOf(pizza, id, 'pizza').length),
		).toEqual([1, 1, 1])
		const asteroid = send(atFirstAnte(four), 'ann', play('asteroid', 1)).state
		const hit = four.filter(
			(id) => itemsOf(asteroid, id, 'asteroid').length === 1,
		)
		expect(hit).toHaveLength(1)
		expect(hit).not.toContain('ann')
	})

	it('is refused before the player has reported an ante, and for an unknown effect', () => {
		const early = send(runState(DUEL), 'ann', play('pizza', 1))
		expect(early.refusals).toEqual(['no_progress'])
		const unknown = send(atFirstAnte(DUEL), 'ann', play('meteor', 1))
		expect(unknown.refusals).toEqual(['bad_request_body'])
		const huge = send(atFirstAnte(DUEL), 'ann', play('pizza', 385))
		expect(huge.refusals).toEqual(['bad_request_body'])
	})

	it('totals_count_each_action_once: any mix of sends and redos hits once per highest total', () => {
		const step = fc.record({
			effect: fc.constantFrom('asteroid', 'pizza', 'gambling'),
			total: fc.integer({ min: 1, max: 8 }),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 25 }), (steps) => {
				const state = steps.reduce(
					(next, body) =>
						send(next, 'ann', play(body.effect, body.total)).state,
					atFirstAnte(DUEL),
				)
				for (const effect of ['asteroid', 'pizza', 'gambling']) {
					const highest = Math.max(
						0,
						...steps
							.filter((body) => body.effect === effect)
							.map((body) => body.total),
					)
					expect(itemsOf(state, 'bob', effect)).toHaveLength(highest)
				}
				const numbers = runOf(state).players.bob.inbox.map(
					(item) => item.itemNumber,
				)
				expect(numbers).toEqual(numbers.map((_, index) => index + 1))
			}),
		)
	})
})
