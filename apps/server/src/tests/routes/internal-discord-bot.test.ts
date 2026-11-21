import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { createDiscordBotRouter } from '../../features/discord-bot/discord-bot.route.js'
import {
	NoActiveSeasonError,
	type StandingsDeps,
	createStandingsService,
} from '../../features/discord-bot/standings.service.js'
import type { BoardReads } from '../../infrastructure/gateways/discord-standings.gateway.js'
import { errorHandler } from '../../middleware/errorHandler.js'
import { hashProviderId } from '../../shared/utils/hash.js'

const KEY = 'bot-key'
const original = env.DISCORD_BOT_API_KEY
const originalInternal = env.INTERNAL_API_KEY
const ALICE = '111111111111111111'
const BOB = '222222222222222222'
const CAROL = '333333333333333333'
const BOARD = {
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
}

function appWith(standings = vi.fn(), changes = vi.fn()) {
	const app = express()
	app.use(express.json())
	app.use(
		'/internal/discord-bot',
		createDiscordBotRouter({ standings, changes }),
	)
	app.use(errorHandler)
	return app
}

describe('/internal/discord-bot', () => {
	afterEach(() => {
		env.DISCORD_BOT_API_KEY = original
		env.INTERNAL_API_KEY = originalInternal
	})

	it('refuses everything while no key is configured', async () => {
		env.DISCORD_BOT_API_KEY = ''
		const res = await request(appWith())
			.post('/internal/discord-bot/standings')
			.set('X-BMP-Internal-Key', '')
		expect(res.status).toBe(401)
	})

	it("refuses Nakama's key", async () => {
		env.DISCORD_BOT_API_KEY = KEY
		env.INTERNAL_API_KEY = 'nakama-key'
		const res = await request(appWith())
			.post('/internal/discord-bot/standings')
			.set('X-BMP-Internal-Key', 'nakama-key')
		expect(res.status).toBe(403)
	})

	it('rejects an unknown board, a bad topN and bad ids', async () => {
		env.DISCORD_BOT_API_KEY = KEY
		const standings = vi.fn()
		const app = appWith(standings)
		const post = (body: object) =>
			request(app)
				.post('/internal/discord-bot/standings')
				.set('X-BMP-Internal-Key', KEY)
				.send(body)
		expect(
			(
				await post({
					...BOARD,
					gameMode: 'ranked:pvp_ranked_expandd',
					topN: 50,
					discordIds: [],
				})
			).status,
		).toBe(400)
		// A known mode without the ranked: prefix has no rating rows: reading
		// it would strip everyone's roles.
		expect(
			(
				await post({
					...BOARD,
					gameMode: 'pvp_ranked_expanded',
					topN: 50,
					discordIds: [],
				})
			).status,
		).toBe(400)
		// Names on Object.prototype are not boards.
		for (const board of [
			{ ...BOARD, gameMode: 'ranked:constructor' },
			{ ...BOARD, modId: '__proto__' },
			{ ...BOARD, modId: 'constructor' },
		])
			expect((await post({ ...board, topN: 50, discordIds: [] })).status).toBe(
				400,
			)
		expect((await post({ ...BOARD, topN: 201, discordIds: [] })).status).toBe(
			400,
		)
		expect((await post({ ...BOARD, topN: 1.5, discordIds: [] })).status).toBe(
			400,
		)
		expect(
			(await post({ ...BOARD, topN: 50, discordIds: ['abc'] })).status,
		).toBe(400)
		expect(
			(await post({ ...BOARD, topN: 50, discordIds: Array(1001).fill(ALICE) }))
				.status,
		).toBe(400)
		expect(standings).not.toHaveBeenCalled()
	})

	it('answers 503 between seasons', async () => {
		env.DISCORD_BOT_API_KEY = KEY
		const standings = vi
			.fn()
			.mockRejectedValue(new NoActiveSeasonError('No active season'))
		const res = await request(appWith(standings))
			.post('/internal/discord-bot/standings')
			.set('X-BMP-Internal-Key', KEY)
			.send({ ...BOARD, topN: 50, discordIds: [ALICE] })
		expect(res.status).toBe(503)
	})

	it('passes a valid request through', async () => {
		env.DISCORD_BOT_API_KEY = KEY
		const answer = { season: 2, previousSeason: 1, players: {}, top: [] }
		const standings = vi.fn().mockResolvedValue(answer)
		const res = await request(appWith(standings))
			.post('/internal/discord-bot/standings')
			.set('X-BMP-Internal-Key', KEY)
			.send({ ...BOARD, topN: 50, discordIds: [ALICE, BOB] })
		expect(res.status).toBe(200)
		expect(res.body).toEqual(answer)
		expect(standings).toHaveBeenCalledWith({
			...BOARD,
			topN: 50,
			discordIds: [ALICE, BOB],
		})
	})

	it('checks /changes requests and passes valid ones through', async () => {
		env.DISCORD_BOT_API_KEY = KEY
		const answer = { season: 2, cursor: 'c', changed: [], top: [] }
		const changes = vi.fn().mockResolvedValue(answer)
		const app = appWith(vi.fn(), changes)
		const post = (body: object) =>
			request(app)
				.post('/internal/discord-bot/changes')
				.set('X-BMP-Internal-Key', KEY)
				.send(body)
		expect((await post({ ...BOARD, topN: 50, since: 'soon' })).status).toBe(400)
		expect((await post({ ...BOARD, topN: 50 })).status).toBe(400)
		expect(
			(await post({ ...BOARD, gameMode: 'x', topN: 50, since: null })).status,
		).toBe(400)
		expect(changes).not.toHaveBeenCalled()

		const since = '2026-11-19T12:00:00.000Z'
		const res = await post({ ...BOARD, topN: 50, since })
		expect(res.status).toBe(200)
		expect(res.body).toEqual(answer)
		expect(changes).toHaveBeenCalledWith({ ...BOARD, topN: 50, since })
	})

	it('answers /changes with 503 between seasons', async () => {
		env.DISCORD_BOT_API_KEY = KEY
		const changes = vi
			.fn()
			.mockRejectedValue(new NoActiveSeasonError('No active season'))
		const res = await request(appWith(vi.fn(), changes))
			.post('/internal/discord-bot/changes')
			.set('X-BMP-Internal-Key', KEY)
			.send({ ...BOARD, topN: 50, since: null })
		expect(res.status).toBe(503)
	})
})

describe('standings service', () => {
	function deps(over: Partial<StandingsDeps> = {}): StandingsDeps {
		return {
			hashDiscordId: hashProviderId,
			currentSeasonId: async () => 2,
			previousSeasonId: async () => 1,
			// Alice and Bob linked Discord, Carol did not.
			playerIdsByDiscordIdHash: async (hashes) =>
				new Map(
					[
						[hashProviderId(ALICE), 'p-alice'],
						[hashProviderId(BOB), 'p-bob'],
					].filter(([h]) => hashes.includes(h)) as [string, string][],
				),
			inBoardSnapshot: (read) => read(reads()),
			now: () => new Date('2026-11-19T12:00:00.000Z'),
			...over,
		}
	}

	function reads(over: Partial<BoardReads> = {}): BoardReads {
		return {
			boardRatings: async (board) =>
				board.seasonId === 2
					? new Map([['p-alice', { gamesPlayed: 30, rating: 1300 }]])
					: new Map([
							['p-alice', { gamesPlayed: 50, rating: 1250 }],
							['p-bob', { gamesPlayed: 12, rating: 760 }],
						]),
			topPlayerIds: async () => ['p-someone', 'p-alice'],
			playersChangedSince: async () => [
				{ playerId: 'p-alice', updatedAt: new Date('2026-11-19T11:59:45Z') },
			],
			...over,
		}
	}

	it('hashes ids like Discord linking does and leaves unlinked members out', async () => {
		const service = createStandingsService(deps())
		const answer = await service.standings({
			...BOARD,
			topN: 50,
			discordIds: [ALICE, BOB, CAROL],
		})
		expect(answer).toEqual({
			season: 2,
			previousSeason: 1,
			players: {
				[ALICE]: {
					playerId: 'p-alice',
					current: { gamesPlayed: 30, rating: 1300 },
					previous: { gamesPlayed: 50, rating: 1250 },
				},
				[BOB]: {
					playerId: 'p-bob',
					current: null,
					previous: { gamesPlayed: 12, rating: 760 },
				},
			},
			top: ['p-someone', 'p-alice'],
		})
	})

	it('reads the leaderboard on the current season and skips it for topN 0', async () => {
		const topPlayerIds = vi.fn().mockResolvedValue([])
		const service = createStandingsService(
			deps({ inBoardSnapshot: (read) => read(reads({ topPlayerIds })) }),
		)
		await service.standings({ ...BOARD, topN: 50, discordIds: [ALICE] })
		expect(topPlayerIds).toHaveBeenCalledWith({ ...BOARD, seasonId: 2 }, 50)
		topPlayerIds.mockClear()
		await service.standings({ ...BOARD, topN: 0, discordIds: [ALICE] })
		expect(topPlayerIds).not.toHaveBeenCalled()
	})

	it('has no previous standings in the first season', async () => {
		const boardRatings = vi.fn().mockResolvedValue(new Map())
		const service = createStandingsService(
			deps({
				previousSeasonId: async () => null,
				inBoardSnapshot: (read) => read(reads({ boardRatings })),
			}),
		)
		const answer = await service.standings({
			...BOARD,
			topN: 0,
			discordIds: [BOB],
		})
		expect(answer.previousSeason).toBeNull()
		expect(answer.players[BOB]).toEqual({
			playerId: 'p-bob',
			current: null,
			previous: null,
		})
		expect(answer.top).toEqual([])
		expect(boardRatings).toHaveBeenCalledTimes(1)
	})

	it('does every board read inside one snapshot', async () => {
		const order: string[] = []
		const service = createStandingsService(
			deps({
				inBoardSnapshot: async (read) => {
					order.push('open')
					const out = await read({
						boardRatings: async (board) => {
							order.push(`ratings ${board.seasonId}`)
							return new Map()
						},
						topPlayerIds: async () => {
							order.push('top')
							return []
						},
						playersChangedSince: async () => [],
					})
					order.push('close')
					return out
				},
			}),
		)
		await service.standings({ ...BOARD, topN: 50, discordIds: [ALICE] })
		expect(order).toEqual(['open', 'ratings 2', 'ratings 1', 'top', 'close'])
	})

	it('throws without an active season', async () => {
		const service = createStandingsService(
			deps({ currentSeasonId: async () => null }),
		)
		await expect(
			service.standings({ ...BOARD, topN: 0, discordIds: [] }),
		).rejects.toBeInstanceOf(NoActiveSeasonError)
	})

	it('names who changed since the cursor, minus the overlap, and the top N', async () => {
		const playersChangedSince = vi
			.fn()
			.mockResolvedValue([
				{ playerId: 'p-alice', updatedAt: new Date('2026-11-19T11:59:45Z') },
			])
		const service = createStandingsService(
			deps({ inBoardSnapshot: (read) => read(reads({ playersChangedSince })) }),
		)
		const since = '2026-11-19T11:59:30.000Z'
		expect(await service.changes({ ...BOARD, topN: 50, since })).toEqual({
			season: 2,
			cursor: '2026-11-19T11:58:00.000Z',
			changed: [{ playerId: 'p-alice', updatedAt: '2026-11-19T11:59:45.000Z' }],
			top: ['p-someone', 'p-alice'],
		})
		expect(playersChangedSince).toHaveBeenCalledWith(
			{ ...BOARD, seasonId: 2 },
			new Date(since),
		)
	})

	it('only hands out a cursor on the first call', async () => {
		const playersChangedSince = vi.fn()
		const service = createStandingsService(
			deps({ inBoardSnapshot: (read) => read(reads({ playersChangedSince })) }),
		)
		const answer = await service.changes({ ...BOARD, topN: 0, since: null })
		expect(answer).toMatchObject({ changed: [], top: [] })
		expect(playersChangedSince).not.toHaveBeenCalled()
	})

	it('reads changes and the top list in one snapshot', async () => {
		const order: string[] = []
		const service = createStandingsService(
			deps({
				inBoardSnapshot: async (read) => {
					order.push('open')
					const out = await read(
						reads({
							playersChangedSince: async () => {
								order.push('changed')
								return []
							},
							topPlayerIds: async () => {
								order.push('top')
								return []
							},
						}),
					)
					order.push('close')
					return out
				},
			}),
		)
		await service.changes({ ...BOARD, topN: 50, since: '2026-11-19T11:00:00Z' })
		expect(order).toEqual(['open', 'changed', 'top', 'close'])
	})
})
