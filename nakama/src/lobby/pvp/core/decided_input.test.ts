import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { agreedResult, setResult } from '../inputs/finish'
import { handleMessage } from '../match_hooks/pvp_shell'
import { inputHandlers } from './apply'
import { runOf, send } from '../testing/inputs'
import { reported, runState } from '../testing/state'
import type { InputFacts } from '../match_hooks/pvp_shell'
import type { State } from './types'

const PLAYERS = ['ann', 'bob']

const facts = (state: State): InputFacts => ({
	ranked: true,
	left: [],
	awayFrom: {},
	messageNumbers: {},
	sessions: Object.fromEntries(
		Object.keys(state.players).map((id) => [id, 's1']),
	),
})

// Every gameplay kind with a body the part accepts, so a refusal can only come from the match being decided.
const BODIES: { [field: string]: unknown }[] = [
	{ kind: 'blindStart', blindKey: '2:Boss', handsLeft: 4, score: '0' },
	{ kind: 'handPlayed', blindKey: '2:Boss', handsLeft: 3 },
	{ kind: 'handScored', blindKey: '2:Boss', handsLeft: 4, score: '0' },
	{ kind: 'progress', ante: 3, location: 'shop' },
	{ kind: 'blindResult', blindKey: '1:Small', result: 'lost' },
	{ kind: 'skip', blindKey: '1:Small', total: 1 },
	{ kind: 'sell', ante: 2, total: 1 },
	{ kind: 'shop', ante: 2, total: 1, spent: 5 },
	{ kind: 'voucher', voucherKey: 'v_overstock' },
	{ kind: 'timerStart', timer: 'ante' },
	{ kind: 'timerPause' },
	{ kind: 'paidPreviews', total: 1 },
	{ kind: 'animating', on: true },
	{ kind: 'vote', topic: 'draw', yes: true },
	{ kind: 'forfeit' },
	{ kind: 'ready', ready: true, blindKey: '2:Boss' },
]

// Every kind in the table: the check runs before the body is read, so a kind alone is enough.
const KINDS = Object.keys(inputHandlers).filter((kind) => kind !== 'endGame')
const bodyOf = (kind: string): { [field: string]: unknown } =>
	BODIES.find((body) => body.kind === kind) ?? { kind }

const decided = (): State =>
	setResult(reported(runState(PLAYERS)), agreedResult())

function standing(state: State) {
	return {
		result: state.result,
		lives: runOf(state).lives,
		places: runOf(state).places,
	}
}

describe('input on a decided match', () => {
	it('a lost blind sent after the forfeit that decided the match changes nothing', () => {
		const start = reported(runState(PLAYERS))
		const forfeited = handleMessage(
			start,
			'bob',
			's1',
			{
				messageNumber: 1,
				inboxDone: 0,
				runId: 'run-1',
				kind: 'forfeit',
			},
			0,
			facts(start),
		)
		expect(forfeited.state.result).toMatchObject({ kind: 'win' })
		const before = standing(forfeited.state)
		const after = handleMessage(
			forfeited.state,
			'ann',
			's1',
			{
				messageNumber: 1,
				inboxDone: 0,
				runId: 'run-1',
				kind: 'blindResult',
				blindKey: '1:Small',
				result: 'lost',
			},
			0,
			facts(forfeited.state),
		)
		expect(after.refusals).toEqual(['already_decided'])
		expect(after.lastNumber).toBe(1)
		expect(standing(after.state)).toEqual(before)
	})

	it.each(KINDS.map((kind) => [kind] as const))(
		'%s is refused with already_decided',
		(kind) => {
			const result = send(decided(), 'ann', { kind })
			expect(result.refusals).toEqual(['already_decided'])
			expect(standing(result.state)).toEqual(standing(decided()))
		},
	)

	it('endGame is still taken and stored', () => {
		const body = {
			kind: 'endGame',
			jokers: 'j',
			deck: 'd',
			stats: { rerollCount: 1, rerollCostTotal: 2 },
		}
		const result = send(decided(), 'ann', body)
		expect(result.refusals).toEqual([])
		const { kind: _kind, ...fields } = body
		expect(runOf(result.state).endGames.ann).toEqual(fields)
	})

	it('applied is no refusal on a decided match', () => {
		const result = send(decided(), 'ann', { kind: 'applied' })
		expect(result.refusals).toEqual([])
		expect(result.lastNumber).toBe(1)
	})

	it('after the result no input changes the result, lives or places', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						player: fc.constantFrom(...PLAYERS),
						body: fc.constantFrom(...KINDS.map(bodyOf)),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				(inputs) => {
					let state = decided()
					const before = standing(state)
					for (const { player, body } of inputs) {
						state = send(state, player, body).state
						expect(standing(state)).toEqual(before)
					}
				},
			),
		)
	})
})
