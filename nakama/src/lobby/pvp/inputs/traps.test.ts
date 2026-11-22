import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { InboxItem, State, Trap } from '../core/types'
import { runOf, send } from '../testing/inputs'
import { pairedRun, runInMode, runState } from '../testing/state'
import {
	ARCANE_LOCK_KEY,
	MAX_FIRE_DATA_KEYS,
	MAX_FIRE_DATA_KEY_LENGTH,
	trapsView,
} from './traps'

const DUEL = ['ann', 'bob']
const SNARE = 'c_mp_trap_snare'
const MOUTH = 'c_mp_trap_magic_mouth'
const NO_DATA = {}

function trapDataOf(item: InboxItem): unknown {
	if (item.effect !== 'trapReward') throw new Error('not a trap reward')
	return item.trap.data
}

function atFirstAnte(players: string[]): State {
	return players.reduce(
		(state, player) =>
			send(state, player, { kind: 'progress', ante: 1, location: 'shop' })
				.state,
		runState(players),
	)
}

const plant = (key: string, total: number) => ({
	kind: 'trapPlant',
	key,
	total,
})
const fire = (trapId: number, data: object = NO_DATA) => ({
	kind: 'trapFire',
	trapId,
	data,
})
const trapsOf = (state: State) => runOf(state).traps

function atAnte(state: State, players: string[], ante: number): State {
	return players.reduce(
		(next, player) =>
			send(next, player, { kind: 'progress', ante, location: 'shop' }).state,
		state,
	)
}

function withTraps(state: State, traps: Trap[]): State {
	return { ...state, run: { ...runOf(state), traps } }
}

// Three players at ante 2 where cy has the bye and so nobody to plant at.
function byeRun(): State {
	const three = ['ann', 'bob', 'cy']
	return atAnte(
		pairedRun(three, { ann: 'bob', bob: 'ann', cy: null }),
		three,
		2,
	)
}

const lockHeldBy = (id: number, owner: string, holder: string): Trap => ({
	id,
	key: ARCANE_LOCK_KEY,
	owner,
	holder,
	state: 'live',
})

describe('trapPlant', () => {
	it('makes a live trap owned by the planter and held by the opponent', () => {
		const state = send(atFirstAnte(DUEL), 'ann', plant(SNARE, 1)).state
		expect(trapsOf(state)).toEqual([
			{ id: 1, key: SNARE, owner: 'ann', holder: 'bob', state: 'live' },
		])
	})

	it('plants_are_per_key: a redo of one key cannot swallow or swap a trap of another', () => {
		let state = send(atFirstAnte(DUEL), 'ann', plant(SNARE, 1)).state
		state = send(state, 'ann', plant(MOUTH, 1)).state
		state = send(state, 'ann', plant(SNARE, 1)).state
		expect(trapsOf(state).map((trap) => trap.key)).toEqual([SNARE, MOUTH])
		state = send(state, 'ann', plant(SNARE, 2)).state
		expect(trapsOf(state).map((trap) => trap.key)).toEqual([
			SNARE,
			MOUTH,
			SNARE,
		])
	})

	it.each([
		['a key past 64 characters', `c_mp_${'x'.repeat(60)}`, 'bad_request_body'],
	])('refuses %s', (_name, key, code) => {
		const state = atFirstAnte(DUEL)
		const result = send(state, 'ann', plant(key, 1))
		expect(result.refusals).toEqual([code])
		expect(trapsOf(result.state)).toEqual([])
	})

	it('refuses a plant before an ante is reported', () => {
		expect(send(runState(DUEL), 'ann', plant(SNARE, 1)).refusals).toEqual([
			'no_progress',
		])
	})

	it('a planter holding a live Arcane Lock sends the trap back to the lock owner', () => {
		let state = send(atFirstAnte(DUEL), 'ann', plant(ARCANE_LOCK_KEY, 1)).state
		state = send(state, 'bob', plant(SNARE, 1)).state
		expect(trapsOf(state)).toEqual([
			{
				id: 1,
				key: ARCANE_LOCK_KEY,
				owner: 'ann',
				holder: 'bob',
				state: 'fired',
			},
			{ id: 2, key: SNARE, owner: 'ann', holder: 'bob', state: 'live' },
		])
		expect(runOf(state).players.ann.inbox).toEqual([
			{
				itemNumber: 1,
				from: 'bob',
				effect: 'trapReward',
				amount: 1,
				trap: { id: 1, key: ARCANE_LOCK_KEY, data: {} },
			},
		])
	})

	it('one lock bounces one planted card, however many opponents the planter has', () => {
		const three = ['ann', 'bob', 'cy']
		const hunt = atAnte(
			runInMode(three, 'manhunt', {
				ann: 'RUNNER',
				bob: 'HUNTER',
				cy: 'HUNTER',
			}),
			three,
			1,
		)
		const locked = withTraps(hunt, [lockHeldBy(1, 'ann', 'bob')])
		const state = send(locked, 'bob', plant(SNARE, 1)).state
		expect(trapsOf(state)).toEqual([
			{ ...lockHeldBy(1, 'ann', 'bob'), state: 'fired' },
			{ id: 2, key: SNARE, owner: 'ann', holder: 'bob', state: 'live' },
		])
	})

	it('a lock still bounces a card of a planter with nobody to plant at', () => {
		const locked = withTraps(byeRun(), [lockHeldBy(1, 'ann', 'cy')])
		const state = send(locked, 'cy', plant(SNARE, 1)).state
		expect(
			trapsOf(state).map((trap) => [trap.id, trap.owner, trap.state]),
		).toEqual([
			[1, 'ann', 'fired'],
			[2, 'ann', 'live'],
		])
		expect(runOf(state).players.ann.inbox).toHaveLength(1)
	})

	it('a spent lock does not bounce a second card', () => {
		let state = send(atFirstAnte(DUEL), 'ann', plant(ARCANE_LOCK_KEY, 1)).state
		state = send(state, 'bob', plant(SNARE, 1)).state
		state = send(state, 'bob', plant(MOUTH, 1)).state
		expect(
			trapsOf(state).map((trap) => [trap.key, trap.owner, trap.holder]),
		).toEqual([
			[ARCANE_LOCK_KEY, 'ann', 'bob'],
			[SNARE, 'ann', 'bob'],
			[MOUTH, 'bob', 'ann'],
		])
		expect(runOf(state).players.ann.inbox).toHaveLength(1)
	})

	it('a lock held by someone else does not bounce the planter', () => {
		let state = send(atFirstAnte(DUEL), 'ann', plant(ARCANE_LOCK_KEY, 1)).state
		state = send(state, 'ann', plant(SNARE, 1)).state
		expect(trapsOf(state)[1]).toEqual({
			id: 2,
			key: SNARE,
			owner: 'ann',
			holder: 'bob',
			state: 'live',
		})
		expect(trapsOf(state)[0].state).toBe('live')
		expect(runOf(state).players.ann.inbox).toEqual([])
	})
})

describe('trapFire and trapLost', () => {
	const planted = () => send(atFirstAnte(DUEL), 'ann', plant(SNARE, 1)).state

	it('a fire reaches the owner as one trapReward, once per trap', () => {
		let state = send(
			planted(),
			'bob',
			fire(1, { tagKey: 'tag_double', golds: 3 }),
		).state
		expect(runOf(state).players.ann.inbox).toEqual([
			{
				itemNumber: 1,
				from: 'bob',
				effect: 'trapReward',
				amount: 1,
				trap: {
					id: 1,
					key: SNARE,
					data: { tagKey: 'tag_double', golds: 3 },
				},
			},
		])
		const again = send(state, 'bob', fire(1))
		expect(again.refusals).toEqual(['already_fired'])
		expect(again.state.run).toEqual(state.run)
		state = send(state, 'bob', { kind: 'trapLost', trapId: 1 }).state
		expect(trapsOf(state)[0].state).toBe('fired')
	})

	it('a trap that was lost is never fired afterwards', () => {
		let state = send(planted(), 'bob', { kind: 'trapLost', trapId: 1 }).state
		expect(trapsOf(state)[0].state).toBe('lost')
		const result = send(state, 'bob', fire(1))
		expect(result.refusals).toEqual(['already_fired'])
		state = result.state
		expect(runOf(state).players.ann.inbox).toEqual([])
	})

	it('the owner and a player outside the trap cannot fire or lose it', () => {
		const four = ['ann', 'bob', 'cy', 'di']
		const state = send(atFirstAnte(four), 'ann', plant(SNARE, 1)).state
		const trap = trapsOf(state)[0]
		const outsider = four.find(
			(id) => id !== trap.owner && id !== trap.holder,
		) as string
		for (const sender of [trap.owner, outsider]) {
			expect(send(state, sender, fire(1)).refusals).toEqual(['not_holder'])
			expect(
				send(state, sender, { kind: 'trapLost', trapId: 1 }).refusals,
			).toEqual(['not_holder'])
		}
		expect(send(state, trap.holder, fire(9)).refusals).toEqual(['not_holder'])
	})

	it('an Arcane Lock never takes a fire from a player', () => {
		const state = send(
			atFirstAnte(DUEL),
			'ann',
			plant(ARCANE_LOCK_KEY, 1),
		).state
		expect(send(state, 'bob', fire(1)).refusals).toEqual(['arcane_lock'])
	})

	it('passes any small record on as sent, the server naming no field', () => {
		const data = { anything: 'goes', n: 7, flag: true }
		const state = send(planted(), 'bob', fire(1, data)).state
		expect(trapDataOf(runOf(state).players.ann.inbox[0])).toEqual(data)
		const empty = send(planted(), 'bob', fire(1, NO_DATA)).state
		expect(trapDataOf(runOf(empty).players.ann.inbox[0])).toEqual({})
	})

	it('reads an empty list as an empty record, the way Lua sends an empty table', () => {
		const state = send(planted(), 'bob', fire(1, [])).state
		expect(trapDataOf(runOf(state).players.ann.inbox[0])).toEqual({})
	})

	it.each([
		['a nested value', { card: { key: 'j_joker' } }],
		['a list value', { cards: ['a'] }],
		['a null value', { tagKey: null }],
		[
			'too many fields',
			Object.fromEntries(
				Array.from({ length: MAX_FIRE_DATA_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
			),
		],
		[
			'a field name that is too long',
			{ ['k'.repeat(MAX_FIRE_DATA_KEY_LENGTH + 1)]: 1 },
		],
		[
			'a record that is too big',
			Object.fromEntries(
				Array.from({ length: MAX_FIRE_DATA_KEYS }, (_, i) => [
					`k${i}`,
					'x'.repeat(100),
				]),
			),
		],
		['a record that is a list', [1]],
		['a record that is a list of an empty record', [{}]],
		['a record that is a list of an empty list', [[]]],
	])('bad_body_is_confirmed_and_refused: %s', (_name, data) => {
		const state = planted()
		const result = send(state, 'bob', fire(1, data))
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(result.state.run).toEqual(state.run)
	})
})

describe('trap totals', () => {
	it('totals_count_each_action_once: the traps made are the highest total of each key', () => {
		const step = fc.record({
			key: fc.constantFrom(SNARE, MOUTH),
			total: fc.integer({ min: 1, max: 6 }),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 25 }), (steps) => {
				const state = steps.reduce(
					(next, body) => send(next, 'ann', plant(body.key, body.total)).state,
					atFirstAnte(DUEL),
				)
				const highest = (key: string): number =>
					Math.max(
						0,
						...steps
							.filter((body) => body.key === key)
							.map((body) => body.total),
					)
				const targets = 1
				expect(trapsOf(state)).toHaveLength(
					(highest(SNARE) + highest(MOUTH)) * targets,
				)
			}),
		)
	})
})

describe('trapsView', () => {
	it('view_never_leaks_hidden_fields: a player sees only traps it owns or holds', () => {
		const step = fc.record({
			sender: fc.constantFrom('ann', 'bob', 'cy', 'di'),
			key: fc.constantFrom(SNARE, MOUTH, ARCANE_LOCK_KEY),
			total: fc.integer({ min: 1, max: 3 }),
		})
		fc.assert(
			fc.property(fc.array(step, { maxLength: 20 }), (steps) => {
				const four = ['ann', 'bob', 'cy', 'di']
				const state = steps.reduce(
					(next, body) =>
						send(next, body.sender, plant(body.key, body.total)).state,
					atFirstAnte(four),
				)
				for (const viewer of four) {
					const seen = JSON.stringify(trapsView(state, viewer))
					for (const trap of trapsOf(state)) {
						const mine = trap.owner === viewer || trap.holder === viewer
						expect(seen.includes(`"id":${trap.id},`)).toBe(mine)
					}
				}
			}),
		)
	})
})
