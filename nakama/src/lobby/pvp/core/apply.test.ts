import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { runState } from '../testing/state'
import {
	type NumberedResult,
	type InputHandler,
	type InputHandlers,
	apply,
} from './apply'
import { changeRunPlayer } from './run_player'
import { addInboxItem } from './inbox'
import type { State } from './types'

// Rows for the table: the real ones arrive with the inputHandlers.
const sell: InputHandler<{
	ante: { type: 'whole'; max: 2 }
	total: { type: 'whole' }
}> = {
	spec: {
		ante: { type: 'whole', max: 2 },
		total: { type: 'whole' },
	},
	handle: (state, player) =>
		addInboxItem(state, player, {
			from: null,
			effect: 'comebackBonus',
			amount: 1,
		}),
}
const team: InputHandler<{
	team: { type: 'oneOf'; values: readonly ['A', 'B'] }
}> = {
	spec: { team: { type: 'oneOf', values: ['A', 'B'] } },
	beforeRun: true,
	handle: (state) => state,
}
const stale: InputHandler = {
	spec: {},
	handle: () => ({ refusal: 'stale' }),
}
const table: InputHandlers = { sell, team, stale }

const PLAYERS = ['ann', 'bob']
const start = (): State => runState(PLAYERS)

// `last` is the newest number taken from the player; by default the input is the next one.
function send(
	state: State,
	player: string,
	input: { [field: string]: unknown },
	last?: number,
): NumberedResult {
	const number = input.messageNumber
	const own =
		typeof number === 'number' && Number.isSafeInteger(number) && number >= 1
			? number - 1
			: 0
	return apply(state, player, input, last ?? own, 0, table)
}

const header = (messageNumber: number, extra: object = {}) => ({
	messageNumber,
	inboxDone: 0,
	runId: 'run-1',
	...extra,
})
const sale = (messageNumber: number, total: number) =>
	header(messageNumber, { kind: 'sell', ante: 1, total })

describe('the dispatch table', () => {
	it('a kind that is not in it is a bad body, confirmed', () => {
		const result = apply(start(), 'ann', header(1, { kind: 'sell' }), 0, 0)
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(result.lastNumber).toBe(1)
	})
})

describe('input header rules', () => {
	it.each<[string, { [field: string]: unknown }, string]>([
		[
			'messageNumber missing',
			{ inboxDone: 0, runId: 'run-1', kind: 'applied' },
			'unreadable_header',
		],
		['messageNumber 0', header(0, { kind: 'applied' }), 'unreadable_header'],
		['messageNumber -1', header(-1, { kind: 'applied' }), 'unreadable_header'],
		[
			'messageNumber NaN',
			header(Number.NaN, { kind: 'applied' }),
			'unreadable_header',
		],
		[
			'messageNumber a fraction',
			header(1.5, { kind: 'applied' }),
			'unreadable_header',
		],
		[
			'messageNumber text',
			header(1, { kind: 'applied', messageNumber: '1' }),
			'unreadable_header',
		],
		[
			'inboxDone missing',
			{ messageNumber: 1, runId: 'run-1', kind: 'applied' },
			'unreadable_header',
		],
		[
			'inboxDone negative',
			header(1, { kind: 'applied', inboxDone: -1 }),
			'unreadable_header',
		],
	])('%s: dropped, not confirmed', (_name, input, code) => {
		const result = send(start(), 'ann', input)
		expect(result.state).toEqual(start())
		expect(result.refusals).toEqual([code])
		expect(result.lastNumber).toBe(0)
	})

	it.each<[string, unknown]>([
		['null', null],
		['a number', 7],
		['an array', []],
	])('a message that is %s is dropped', (_name, input) => {
		expect(apply(start(), 'ann', input, 0, 0, table).refusals).toEqual([
			'unreadable_header',
		])
	})

	it('a player the match does not know is dropped', () => {
		const result = send(start(), 'zed', header(1, { kind: 'applied' }))
		expect(result.state).toEqual(start())
		expect(result.refusals).toEqual(['unknown_player'])
	})

	it('a player the match knows but the run does not is refused for a run input, never a throw', () => {
		const base = start()
		const state: State = {
			...base,
			players: { ...base.players, cat: { team: null } },
		}
		for (const input of [
			sale(1, 1),
			header(1, { kind: 'applied' }),
			header(1, { kind: 'stale' }),
		]) {
			const result = send(state, 'cat', input)
			expect(result.refusals).toEqual(['unknown_player'])
			expect(result.state.run).toEqual(state.run)
			expect(result.lastNumber).toBe(1)
		}
	})

	it('the handler gets the old highest total, and the new one is written after it', () => {
		const seen: (number | null)[] = []
		const remember: InputHandler['handle'] = (
			state,
			_player,
			_body,
			_now,
			previous,
		) => {
			seen.push(previous)
			return state
		}
		const watched: InputHandlers = {
			skip: { spec: { total: { type: 'whole' } }, handle: remember },
			handPlayed: { spec: {}, handle: remember },
		}
		let state = start()
		const sends: [string, { [field: string]: unknown }][] = [
			['skip', { total: 2 }],
			['skip', { total: 5 }],
			['skip', { total: 5 }],
			['handPlayed', {}],
		]
		sends.forEach(([kind, body], index) => {
			state = apply(
				state,
				'ann',
				header(index + 1, { kind, ...body }),
				index,
				0,
				watched,
			).state
		})
		expect(seen).toEqual([0, 2, null])
		expect(state.run?.players.ann.totals).toEqual({ skip: 5 })
	})

	it('the next number is taken and confirmed', () => {
		const result = send(start(), 'ann', header(1, { kind: 'applied' }))
		expect(result.refusals).toEqual([])
		expect(result.lastNumber).toBe(1)
	})

	it('a refused input is confirmed and changes nothing else', () => {
		const result = send(start(), 'ann', header(1, { kind: 'stale' }))
		expect(result.refusals).toEqual(['stale'])
		expect(result.lastNumber).toBe(1)
		expect(result.state).toEqual(start())
	})

	it('a wrong or missing run id is refused and confirmed', () => {
		const cases: [unknown, string][] = [
			['run-0', 'wrong_run'],
			[null, 'bad_request_body'],
			[undefined, 'bad_request_body'],
			[5, 'bad_request_body'],
		]
		for (const [runId, code] of cases) {
			const result = send(start(), 'ann', { ...sale(1, 1), runId })
			expect(result.lastNumber).toBe(1)
			expect(result.state.run).toEqual(start().run)
			expect(result.refusals).toEqual([code])
		}
	})

	it('a run input with no run in the match is refused', () => {
		const result = send({ ...start(), run: null }, 'ann', sale(1, 1))
		expect(result.refusals).toEqual(['wrong_run'])
		expect(result.lastNumber).toBe(1)
	})

	it('a kind before the run carries no run id, null or missing', () => {
		const ok = send(
			start(),
			'ann',
			header(1, { kind: 'team', team: 'A', runId: null }),
		)
		expect(ok.refusals).toEqual([])
		const missing = send(start(), 'ann', {
			messageNumber: 1,
			inboxDone: 0,
			kind: 'team',
			team: 'A',
		})
		expect(missing.refusals).toEqual([])
		const bad = send(
			start(),
			'ann',
			header(1, { kind: 'team', team: 'A', runId: 'run-1' }),
		)
		expect(bad.refusals).toEqual(['bad_request_body'])
	})

	it('a name from the object prototype is not a kind', () => {
		for (const kind of ['constructor', 'toString', '__proto__'])
			expect(send(start(), 'ann', header(1, { kind })).refusals).toEqual([
				'bad_request_body',
			])
	})
})

describe('bad_body_is_confirmed_and_refused', () => {
	const badBodies: { [field: string]: unknown }[] = [
		{ kind: 'sell', ante: 1 },
		{ kind: 'sell', ante: 1, total: 1.5 },
		{ kind: 'sell', ante: 'rocks', total: 1 },
		{ kind: 'sell', ante: 1, total: 1, extra: 1 },
		{ kind: 7 },
		{},
	]

	it.each(badBodies.map((body) => [JSON.stringify(body), body] as const))(
		'%s',
		(_name, body) => {
			const result = send(start(), 'ann', header(1, body))
			expect(result.refusals).toEqual(['bad_request_body'])
			expect(result.lastNumber).toBe(1)
			expect(result.state).toEqual(start())
			const next = send(result.state, 'ann', sale(2, 1))
			expect(next.refusals).toEqual([])
			expect(next.state.run?.players.ann.inbox).toHaveLength(1)
		},
	)
})

// Any message a client could send, good or bad, with its number.
const inputArbitrary = fc.oneof(
	fc
		.record({
			ante: fc.constantFrom(1, 2, 'rocks'),
			total: fc.nat({ max: 4 }),
			inboxDone: fc.nat({ max: 3 }),
			runId: fc.constantFrom('run-1', 'run-0'),
		})
		.map((input) => ({ kind: 'sell', ...input })),
	fc.constantFrom({ kind: 'stale', runId: 'run-1', inboxDone: 0 }),
	fc.record({
		kind: fc.constant('applied'),
		runId: fc.constant('run-1'),
		inboxDone: fc.nat({ max: 3 }),
	}),
	fc.record({
		kind: fc.constant('team'),
		team: fc.constantFrom('A', 'C'),
		runId: fc.constant(null),
		inboxDone: fc.constant(0),
	}),
)

const messages = fc.array(
	fc.record({
		player: fc.constantFrom('ann', 'bob'),
		input: inputArbitrary,
		offset: fc.constantFrom(0, 0, 0, 1, -1, 2),
	}),
	{ maxLength: 30 },
)

// The match after the steps, and the newest number taken from each player.
function run(steps: { player: string; input: object; offset: number }[]): {
	state: State
	numbers: { [player: string]: number }
} {
	let state = start()
	const numbers: { [player: string]: number } = {}
	for (const step of steps) {
		const last = numbers[step.player] ?? 0
		const taken = send(
			state,
			step.player,
			{ ...step.input, messageNumber: last + 1 + step.offset },
			last,
		)
		state = taken.state
		numbers[step.player] = taken.lastNumber
	}
	return { state, numbers }
}

describe('core_is_deterministic', () => {
	it('the same state and steps give an equal state', () => {
		fc.assert(
			fc.property(messages, (steps) => {
				expect(run(steps)).toEqual(run(steps))
			}),
		)
	})
})

describe('input_twice_changes_nothing', () => {
	it('a second delivery of any input leaves the state equal', () => {
		fc.assert(
			fc.property(messages, inputArbitrary, (steps, input) => {
				const { state, numbers } = run(steps)
				const last = numbers.ann ?? 0
				const message = { ...input, messageNumber: last + 1 }
				const once = send(state, 'ann', message, last)
				const twice = send(once.state, 'ann', message, once.lastNumber)
				expect(twice.state).toEqual(once.state)
				expect(twice.lastNumber).toBe(once.lastNumber)
				expect(twice.refusals).toEqual([])
			}),
		)
	})
})

describe('gap_input_changes_nothing', () => {
	it('an input more than one ahead leaves the state equal', () => {
		fc.assert(
			fc.property(
				messages,
				inputArbitrary,
				fc.integer({ min: 2, max: 50 }),
				(steps, input, skip) => {
					const { state, numbers } = run(steps)
					const last = numbers.ann ?? 0
					const result = send(
						state,
						'ann',
						{ ...input, messageNumber: last + skip },
						last,
					)
					expect(result.state).toEqual(state)
					expect(result.lastNumber).toBe(last)
					expect(result.refusals).toEqual([])
				},
			),
		)
	})

	it('the missing numbers then close the gap in order', () => {
		const second = send(start(), 'ann', sale(2, 2), 0)
		const first = send(second.state, 'ann', sale(1, 1), second.lastNumber)
		const again = send(first.state, 'ann', sale(2, 2), first.lastNumber)
		expect(again.state.run?.players.ann.inbox).toHaveLength(2)
		expect(again.lastNumber).toBe(2)
	})
})

describe('bad_body_is_confirmed_and_refused (any bad body)', () => {
	it('moves only the input number, then a good input is taken', () => {
		fc.assert(
			fc.property(messages, fc.jsonValue(), (steps, junk) => {
				const { state, numbers } = run(steps)
				const next = (numbers.bob ?? 0) + 1
				const body =
					typeof junk === 'object' && junk !== null && !Array.isArray(junk)
						? junk
						: { junk }
				const result = send(
					state,
					'bob',
					{
						...body,
						messageNumber: next,
						inboxDone: 0,
						runId: 'run-1',
						kind: 'nothing',
					},
					next - 1,
				)
				expect(result.state).toEqual(state)
				expect(result.lastNumber).toBe(next)
			}),
		)
	})
})

describe('totals_count_each_action_once', () => {
	const totalsArbitrary = fc.array(
		fc.record({
			ante: fc.constantFrom(1, 2),
			total: fc.nat({ max: 6 }),
		}),
		{ maxLength: 25 },
	)

	// Sends the list, each with the next number after `from`; returns the match and the last number.
	function sendAll(
		state: State,
		list: { ante: number; total: number }[],
		from = 0,
	): { state: State; last: number } {
		let next = state
		let last = from
		for (const item of list) {
			const taken = send(
				next,
				'ann',
				{ ...header(last + 1), kind: 'sell', ...item },
				last,
			)
			next = taken.state
			last = taken.lastNumber
		}
		return { state: next, last }
	}

	it('items equal the number of times each key reached a new highest total', () => {
		fc.assert(
			fc.property(totalsArbitrary, (list) => {
				const highest: { [ante: number]: number } = {}
				let raised = 0
				for (const item of list) {
					if (item.total > (highest[item.ante] ?? 0)) {
						highest[item.ante] = item.total
						raised += 1
					}
				}
				const { state } = sendAll(start(), list)
				const own = state.run?.players.ann
				expect(own?.inbox).toHaveLength(raised)
				expect(own?.totals).toEqual(
					Object.fromEntries(
						Object.keys(highest).map((ante) => [
							`sell:${ante}`,
							highest[Number(ante)],
						]),
					),
				)
			}),
		)
	})

	it('sending the same totals again adds nothing, even with fresh input numbers', () => {
		fc.assert(
			fc.property(totalsArbitrary, (list) => {
				const once = sendAll(start(), list)
				const twice = sendAll(once.state, list, once.last)
				expect(twice.state.run).toEqual(once.state.run)
			}),
		)
	})

	it('another ante or key has its own count', () => {
		const { state } = sendAll(start(), [
			{ ante: 1, total: 2 },
			{ ante: 2, total: 1 },
		])
		expect(state.run?.players.ann.totals).toEqual({ 'sell:1': 2, 'sell:2': 1 })
		expect(state.run?.players.ann.inbox).toHaveLength(2)
	})
})

describe('inbox_done_above_inbox_ignored (through apply)', () => {
	const withTwoItems = (): State => {
		let state = start()
		for (let i = 0; i < 2; i++)
			state = addInboxItem(state, 'ann', {
				from: null,
				effect: 'comebackBonus',
				amount: 1,
			})
		return state
	}

	it('moves the number with a good claim', () => {
		const result = send(
			withTwoItems(),
			'ann',
			header(1, { kind: 'applied', inboxDone: 2 }),
		)
		expect(result.state.run?.players.ann.inboxDone).toBe(2)
		expect(result.refusals).toEqual([])
	})

	it('ignores a claim above the inbox, logs it, and still runs the input', () => {
		const result = send(withTwoItems(), 'ann', {
			...sale(1, 1),
			inboxDone: 3,
		})
		expect(result.refusals).toEqual(['bad_inbox_done'])
		expect(result.state.run?.players.ann.inboxDone).toBe(0)
		expect(result.state.run?.players.ann.inbox).toHaveLength(3)
		expect(result.lastNumber).toBe(1)
	})

	it('a refused transition still moves the claim', () => {
		const result = send(
			withTwoItems(),
			'ann',
			header(1, { kind: 'stale', inboxDone: 2 }),
		)
		expect(result.refusals).toEqual(['stale'])
		expect(result.state.run?.players.ann.inboxDone).toBe(2)
	})

	it('a bad body still moves the claim', () => {
		const result = send(
			withTwoItems(),
			'ann',
			header(1, { kind: 'applied', inboxDone: 2, extra: 1 }),
		)
		expect(result.refusals).toEqual(['bad_request_body'])
		expect(result.state.run?.players.ann.inboxDone).toBe(2)
	})

	it('a total that is not higher still moves the claim', () => {
		const first = send(withTwoItems(), 'ann', sale(1, 3))
		const again = send(first.state, 'ann', { ...sale(2, 3), inboxDone: 2 })
		expect(again.state.run?.players.ann.inboxDone).toBe(2)
	})

	it('a claim sent for another run is not counted', () => {
		const result = send(withTwoItems(), 'ann', {
			...sale(1, 1),
			runId: 'run-0',
			inboxDone: 2,
		})
		expect(result.refusals).toEqual(['wrong_run'])
		expect(result.state.run?.players.ann.inboxDone).toBe(0)
	})

	it('an unreadable header moves no claim', () => {
		const result = send(withTwoItems(), 'ann', {
			...header(0, { kind: 'applied', inboxDone: 2 }),
		})
		expect(result.state.run?.players.ann.inboxDone).toBe(0)
	})

	it('changeRunPlayer refuses a player outside the run', () => {
		expect(() => changeRunPlayer(start(), 'zed', (entry) => entry)).toThrow()
	})
})
