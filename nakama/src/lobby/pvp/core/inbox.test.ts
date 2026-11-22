import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { runState } from '../testing/state'
import {
	INBOX_ITEMS_PER_VIEW,
	addInboxItem,
	recordLastItemDone,
	visibleInbox,
} from './inbox'
import type { NewInboxItem, State } from './types'

const PLAYERS = ['ann', 'bob']
const ITEM: NewInboxItem = {
	from: null,
	effect: 'comebackBonus',
	amount: 3,
}

function withItems(state: State, player: string, count: number): State {
	let next = state
	for (let i = 0; i < count; i++) next = addInboxItem(next, player, ITEM)
	return next
}

type Step =
	| { step: 'add'; player: string }
	| { step: 'done'; player: string; claim: number }

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		step: fc.constant<'add'>('add'),
		player: fc.constantFrom(...PLAYERS),
	}),
	fc.record({
		step: fc.constant<'done'>('done'),
		player: fc.constantFrom(...PLAYERS),
		claim: fc.nat({ max: 80 }),
	}),
)

function play(steps: Step[]): State[] {
	const states = [runState(PLAYERS)]
	for (const step of steps) {
		const before = states[states.length - 1]
		states.push(
			step.step === 'add'
				? addInboxItem(before, step.player, ITEM)
				: recordLastItemDone(before, step.player, step.claim).state,
		)
	}
	return states
}

describe('inbox_numbers_have_no_gap', () => {
	it('numbers run 1..n per player, nothing is renumbered or dropped', () => {
		fc.assert(
			fc.property(fc.array(stepArbitrary, { maxLength: 60 }), (steps) => {
				const states = play(steps)
				for (let i = 1; i < states.length; i++) {
					for (const player of PLAYERS) {
						const before = states[i - 1].run?.players[player]
						const after = states[i].run?.players[player]
						if (!before || !after) throw new Error('player missing')
						expect(after.inbox.map((item) => item.itemNumber)).toEqual(
							after.inbox.map((_item, index) => index + 1),
						)
						expect(after.inbox.slice(0, before.inbox.length)).toEqual(
							before.inbox,
						)
						expect(after.inboxDone).toBeGreaterThanOrEqual(before.inboxDone)
						expect(after.inboxDone).toBeLessThanOrEqual(after.inbox.length)
					}
				}
			}),
		)
	})

	it('one player getting items does not move the other', () => {
		const state = withItems(runState(PLAYERS), 'ann', 3)
		expect(visibleInbox(state, 'bob')).toEqual({ inbox: [], inboxNewest: 0 })
		expect(state.run?.players.ann.inbox).toHaveLength(3)
	})

	it('an item for a player outside the run is a bug, not an input', () => {
		expect(() => addInboxItem(runState(PLAYERS), 'zed', ITEM)).toThrow()
	})
})

describe('inbox_wire_shape', () => {
	it('each effect is sent with exactly its own fields', () => {
		const items: NewInboxItem[] = [
			{ from: null, effect: 'comebackBonus', amount: 1 },
			{ from: 'bob', effect: 'voucherLife', amount: 1 },
		]
		let state = runState(PLAYERS)
		for (const item of items) state = addInboxItem(state, 'ann', item)
		expect(visibleInbox(state, 'ann').inbox).toEqual([
			{ itemNumber: 1, from: null, effect: 'comebackBonus', amount: 1 },
			{ itemNumber: 2, from: 'bob', effect: 'voucherLife', amount: 1 },
		])
		expect(Object.keys(visibleInbox(state, 'ann').inbox[1]).sort()).toEqual([
			'amount',
			'effect',
			'from',
			'itemNumber',
		])
	})
})

describe('inbox_view_window', () => {
	it('is the first 32 items above the last one done; inboxNewest is the length', () => {
		fc.assert(
			fc.property(fc.nat({ max: 70 }), fc.nat({ max: 70 }), (count, claim) => {
				const start = withItems(runState(PLAYERS), 'ann', count)
				const state = recordLastItemDone(start, 'ann', claim).state
				const done = state.run?.players.ann.inboxDone ?? -1
				const view = visibleInbox(state, 'ann')
				const expected = Array.from({ length: count }, (_x, index) => index + 1)
					.filter((number) => number > done)
					.slice(0, INBOX_ITEMS_PER_VIEW)
				expect(view.inbox.map((item) => item.itemNumber)).toEqual(expected)
				expect(view.inboxNewest).toBe(count)
			}),
		)
	})

	it.each<[string, number, number, number[]]>([
		['an empty inbox', 0, 0, []],
		['nothing done', 3, 0, [1, 2, 3]],
		['some done', 5, 2, [3, 4, 5]],
		['all done', 4, 4, []],
		[
			'more than the window',
			40,
			0,
			Array.from({ length: 32 }, (_x, i) => i + 1),
		],
		[
			'the window moves with the number',
			40,
			10,
			Array.from({ length: 30 }, (_x, i) => i + 11),
		],
	])('%s', (_name, count, done, expected) => {
		const state = recordLastItemDone(
			withItems(runState(PLAYERS), 'ann', count),
			'ann',
			done,
		).state
		expect(visibleInbox(state, 'ann').inbox.map((i) => i.itemNumber)).toEqual(
			expected,
		)
	})

	it('shows nothing before a run', () => {
		const state: State = {
			lobbyMode: 'royale',
			players: {},
			run: null,
			result: null,
		}
		expect(visibleInbox(state, 'ann')).toEqual({ inbox: [], inboxNewest: 0 })
	})
})

describe('inbox_done_above_inbox_ignored', () => {
	it.each<[string, number, number, number, string[]]>([
		['moves up', 3, 0, 2, []],
		['moves up to the last item', 3, 1, 3, []],
		[
			'one above the inbox is ignored and reported',
			3,
			1,
			4,
			['bad_inbox_done'],
		],
		['far above is ignored and reported', 3, 2, 1000, ['bad_inbox_done']],
		['below what is known changes nothing', 3, 2, 1, []],
		['the same number changes nothing', 3, 2, 2, []],
	])('%s', (_name, count, known, claim, refusals) => {
		const state = recordLastItemDone(
			withItems(runState(PLAYERS), 'ann', count),
			'ann',
			known,
		).state
		const result = recordLastItemDone(state, 'ann', claim)
		const accepted = claim <= count && claim > known
		expect(result.refusals).toEqual(refusals)
		expect(result.state.run?.players.ann.inboxDone).toBe(
			accepted ? claim : known,
		)
	})

	it('a player outside the run changes nothing', () => {
		const state = runState(PLAYERS)
		expect(recordLastItemDone(state, 'zed', 1)).toEqual({
			state,
			refusals: [],
		})
	})
})
