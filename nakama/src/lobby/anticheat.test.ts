import { describe, expect, it } from 'vitest'
import { MIN_MS_PER_HAND, handCount, runFlags } from './anticheat'
import type { RunRecord } from './protocol'
import { eventsOf, type LogEvent } from '../shared/replay/events'

function log(...opcodes: string[]): LogEvent[] {
	const lines = opcodes.map((op, t) => JSON.stringify([t, op, null]))
	return eventsOf({ lines, bytes: 0, truncated: false })
}

const run = (elapsedMs: number) =>
	({
		runId: 'r',
		startedAt: 1000,
		endedAt: 1000 + elapsedMs,
		players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
	}) as unknown as RunRecord

describe('anti-cheat flags', () => {
	it('counts scored hands', () => {
		expect(handCount(log('match_manifest', 'hand_result', 'play', 'hand_result'))).toBe(2)
		expect(handCount(undefined)).toBe(0)
	})

	it('flags a hash mismatch, then hands faster than the game allows', () => {
		const logs = { a: log('hand_result', 'hand_result'), b: log('hand_result', 'hand_result', 'hand_result'), c: log('hand_result') }
		const flags = runFlags(run(2 * MIN_MS_PER_HAND), logs, { a: 'match', b: 'match', c: 'mismatch' })
		expect(flags).toEqual({ b: 'elapsed_time_gate', c: 'hash_mismatch' })
	})

	it('flags a ranked player whose log is missing, cut off or could not be checked', () => {
		const ranked = { ...run(60_000), rankedMode: 'nemesis' } as RunRecord
		const flags = runFlags(ranked, { a: log('hand_result') }, { a: 'match', b: 'unavailable', c: 'mismatch' })
		expect(flags).toEqual({ b: 'unverified_log', c: 'hash_mismatch' })
	})

	it('flags nobody in a clean game', () => {
		expect(runFlags(run(60_000), { a: log('hand_result') }, { a: 'match', b: 'unavailable', c: 'match' })).toEqual({})
	})
})
