import { describe, expect, it } from 'vitest'
import {
	activeRankedGames,
	clearNakama,
} from '../../features/ratings/season-replay-apply.deps.js'
import { err, ok } from '../../shared/utils/result.js'

describe('activeRankedGames', () => {
	it('counts started ranked lobbies only', async () => {
		const call = (async () =>
			ok({
				lobbies: [
					{ type: 'ranked', started: true },
					{ type: 'ranked', started: false },
					{ type: 'private', started: true },
					{ type: 'public', started: true },
				],
			})) as any
		expect(await activeRankedGames(call)).toEqual(ok(1))
	})

	it('fails closed when Nakama cannot answer', async () => {
		expect(
			await activeRankedGames((async () => err('unreachable')) as any),
		).toEqual(err('unreachable'))
	})
})

describe('clearNakama', () => {
	it('clears the Season, then removes a leaderboard record that had no rating behind it', async () => {
		const calls: [string, any][] = []
		const call = (async (id: string, body: any) => {
			calls.push([id, body])
			if (id === 'admin_ratings_season_clear')
				return ok({ cleared: 2, cursor: body.cursor === '' ? 'next' : '' })
			if (id === 'admin_ratings_board_export')
				return ok({
					records: [
						{
							ownerId: 'orphan',
							username: 'O',
							score: 1,
							subscore: 0,
							metadata: {},
						},
					],
					cursor: '',
				})
			return ok({})
		}) as any
		expect(
			await clearNakama(1, ['MultiplayerPvP:ranked:solo:1'], call),
		).toEqual(ok(null))
		expect(
			calls
				.filter(([id]) => id === 'admin_ratings_season_clear')
				.map(([, b]) => b),
		).toEqual([
			{ season: 1, cursor: '' },
			{ season: 1, cursor: 'next' },
		])
		expect(calls.at(-1)).toEqual([
			'admin_ratings_set',
			{
				modId: 'MultiplayerPvP',
				mode: 'ranked:solo',
				season: 1,
				entries: [{ userId: 'orphan', name: '', record: null }],
			},
		])
	})
})
