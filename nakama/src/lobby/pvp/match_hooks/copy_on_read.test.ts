// The parts and the shell run on the state as Nakama's JS runtime hands it back: every read is
// a new object. Each rule here is run on plain state and on copyOnRead(state).
import { describe, expect, it } from 'vitest'
import { startCountdown } from '../core/clock'
import type { State } from '../core/types'
import { ready, runOf, send } from '../testing/inputs'
import { copyOnRead } from '../testing/copy_on_read'
import { anteStarted, countdownsOf, runOfMode, start } from '../testing/timers'
import { endAwayPauses, settledRun, shellTick } from './pvp_shell'

const reads: [string, <T>(state: T) => T][] = [
	['plain state', (state) => state],
	['copy on read', copyOnRead],
]

function spendable(left: number, cost: number): State {
	const state = runOfMode(['ann', 'bob'], 'nemesis', {
		clocks: {
			ante: 'personal',
			pvp: null,
			personal: {
				kind: 'pressure',
				baseMilliseconds: 100_000,
				timedRate: 1,
				previewCostMilliseconds: cost,
			},
		},
	})
	const run = runOf(state)
	return {
		...state,
		run: {
			...run,
			clocks: startCountdown(
				run.clocks,
				{
					kind: 'personal',
					by: null,
					against: ['ann'],
					lengthMilliseconds: left,
				},
				0,
			),
		},
	}
}

describe.each(reads)('on %s', (_name, read) => {
	it('paidPreviews takes the cost off the personal countdown', () => {
		const after = send(read(spendable(100_000, 20_000)), 'ann', {
			kind: 'paidPreviews',
			total: 1,
		}).state
		expect(countdownsOf(after)[0].endsAt).toBe(80_000)
	})

	it('Ready freezes the Ante countdown against its player and un-ready resumes it', () => {
		const waiting = ready(
			read(runOfMode(['ann', 'bob', 'cat'], 'royale')),
			'ann',
		).state
		const started = start(read(waiting), 'ann', 'ante').state
		const frozen = ready(read(started), 'bob', true, undefined, 1000).state
		expect(countdownsOf(frozen).map((c) => c.hold.kind)).toEqual([
			'counting',
			'paused for ready',
		])
		const back = ready(read(frozen), 'bob', false, undefined, 2000).state
		expect(countdownsOf(back).map((c) => c.hold.kind)).toEqual([
			'counting',
			'counting',
		])
	})

	it('a repeated Ready changes nothing, so un-ready resumes the Ante countdown', () => {
		let state = read(runOfMode(['ann', 'bob', 'cat'], 'royale'))
		state = ready(state, 'ann').state
		state = start(read(state), 'ann', 'ante', 0).state
		state = ready(read(state), 'bob', true, undefined, 1000).state
		const once = ready(read(state), 'bob', true, undefined, 2000)
		expect(once.refusals).toEqual([])
		expect(countdownsOf(once.state)).toEqual(countdownsOf(state))
		const back = ready(read(once.state), 'bob', false, undefined, 3000).state
		expect(
			countdownsOf(back).find((c) => c.against.join() === 'bob')?.hold,
		).toEqual({ kind: 'counting' })
	})

	it('a tick that only runs the clock stores nothing new', () => {
		const run = read(runOf(anteStarted()))
		expect(settledRun(run, 5000)).toBe(run)
		expect(endAwayPauses(run, 5000, { awayFrom: {}, left: [] })).toBe(run)
	})
})

describe('shellTick', () => {
	const facts = {
		ranked: false,
		forfeited: [],
		awayFrom: {},
		gameStarted: true,
		away: [],
		left: [],
		grace: null,
		messageNumbers: {},
	}
	it.each(reads)(
		'%s: a tick that only runs the clock stores nothing new',
		(_name, read) => {
			const state = read(anteStarted())
			expect(shellTick(state, 5000, facts)).toBe(state)
		},
	)
})
