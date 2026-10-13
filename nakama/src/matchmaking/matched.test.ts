import { describe, expect, it } from 'vitest'
import { planMatch, type MatchedEntry } from './matched'

function entry(userId: string, props: { [k: string]: string }): MatchedEntry {
	return { presence: { userId }, properties: props }
}
const RANKED = { modId: 'MultiplayerPvP', mode: 'pvp_ranked_standard', kind: 'ranked' }

describe('planMatch', () => {
	it('plans a ranked lobby on the queued mode', () => {
		expect(planMatch([entry('a', RANKED), entry('b', RANKED)])).toEqual({
			modId: 'MultiplayerPvP',
			rankedMode: 'pvp_ranked_standard',
			gameMode: 'ranked:pvp_ranked_standard',
			playerIds: ['a', 'b'],
		})
	})
	it('plans a casual lobby with no rating board', () => {
		const casual = { modId: 'MultiplayerSPDRN', mode: 'standard', kind: 'casual' }
		const plan = planMatch([entry('a', casual), entry('b', casual), entry('c', casual)])
		expect(plan).toMatchObject({ rankedMode: '', gameMode: 'standard', playerIds: ['a', 'b', 'c'] })
	})
	it('refuses a group that queued for different things', () => {
		const other = { ...RANKED, kind: 'casual' }
		expect(typeof planMatch([entry('a', RANKED), entry('b', other)])).toBe('string')
		expect(typeof planMatch([entry('a', RANKED), entry('b', { ...RANKED, mode: 'x' })])).toBe('string')
	})
	it('refuses one player, a repeated player, and bad names', () => {
		expect(typeof planMatch([entry('a', RANKED)])).toBe('string')
		expect(typeof planMatch([entry('a', RANKED), entry('a', RANKED)])).toBe('string')
		const bad = { ...RANKED, mode: 'no spaces allowed' }
		expect(typeof planMatch([entry('a', bad), entry('b', bad)])).toBe('string')
	})
})
