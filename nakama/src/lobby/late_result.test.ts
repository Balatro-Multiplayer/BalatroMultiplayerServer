import { describe, expect, it } from 'vitest'
import { NotifyCode } from '../notify'
import { lateResultContent, rankedResultContent, sendLateResults, sendRankedResults } from './late_result'
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

describe('ranked results', () => {
	const ranked = {
		...run,
		rankedMode: 'ranked',
		players: [{ id: 'a' }, { id: 'b' }],
		ratings: {
			a: { delta: -12, newRating: 988, isPlacement: false, gamesPlayed: 9 },
			b: { delta: 12, newRating: 1012, isPlacement: false, gamesPlayed: 9 },
		},
	} as unknown as RunRecord
	const collect = (r: RunRecord) => {
		const sent: unknown[][] = []
		const nk = { notificationSend: (...a: unknown[]) => sent.push(a) } as unknown as nkruntime.Nakama
		sendRankedResults(nk, r)
		return sent
	}

	it('tells every rated player of a ranked run, with the code RESULT_RANKED', () => {
		const sent = collect(ranked)
		expect(sent.map((s) => s[0])).toEqual(['a', 'b'])
		expect(sent[0][3]).toBe(NotifyCode.RESULT_RANKED)
		expect(sent[1][5]).toBe(false)
	})

	it('says tied when first place is shared', () => {
		const drawn = { ...ranked, placements: [{ playerId: 'a', place: 1 }, { playerId: 'b', place: 1 }] } as unknown as RunRecord
		expect(rankedResultContent(drawn, 'a').tied).toBe(true)
		expect(rankedResultContent(ranked, 'a').tied).toBe(false)
	})

	it('sends nothing for an unranked run or a player with no rating', () => {
		expect(collect({ ...ranked, rankedMode: null } as unknown as RunRecord)).toHaveLength(0)
		const partial = { ...ranked, ratings: { a: { delta: -12, newRating: 988, isPlacement: false, gamesPlayed: 9 } } } as unknown as RunRecord
		expect(collect(partial).map((s) => s[0])).toEqual(['a'])
	})
})
