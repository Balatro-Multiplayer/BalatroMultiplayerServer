import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { lateResultContent, sendLateResults } from './late_result'
import type { RunRecord } from './protocol'

const run = {
	runId: 'r1',
	code: 'ABC123',
	modId: 'MultiplayerPvP',
	status: 'partial',
	placements: [
		{ playerId: 'b', place: 1 },
		{ playerId: 'a', place: 2 },
	],
	ratings: {
		a: { delta: -12, newRating: 988, isPlacement: false, gamesPlayed: 9 },
	},
} as unknown as RunRecord

describe('lateResultContent', () => {
	it('carries the place and the rating change of the player who left', () => {
		expect(lateResultContent(run, 'a')).toEqual({
			runId: 'r1',
			code: 'ABC123',
			modId: 'MultiplayerPvP',
			status: 'partial',
			place: 2,
			rating: { delta: -12, newRating: 988, isPlacement: false, gamesPlayed: 9 },
		})
	})

	it('has a null rating for an unrated run', () => {
		expect(lateResultContent(run, 'b').rating).toBeNull()
	})
})

describe('sendLateResults', () => {
	it('sends a transient RESULT_LATE notification to each player owed one', () => {
		const sent: unknown[][] = []
		const nk = {
			notificationSend: (...args: unknown[]) => sent.push(args),
		} as unknown as nkruntime.Nakama
		sendLateResults(nk, run, ['a'])
		expect(sent).toHaveLength(1)
		expect(sent[0][0]).toBe('a')
		expect(sent[0][3]).toBe(NotifyCode.RESULT_LATE)
		expect(sent[0][5]).toBe(false)
		expect((sent[0][2] as { place: number }).place).toBe(2)
	})
})
