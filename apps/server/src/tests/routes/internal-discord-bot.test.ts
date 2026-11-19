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

function appWith(standings = vi.fn()) {
	const app = express()
	app.use(express.json())
	app.use('/internal/discord-bot', createDiscordBotRouter({ standings }))
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

	it('answers 503 with no active season', async () => {
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
		const answer = { season: 2, previousSeason: 1, players: {} }
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
			boardRatings: async (board) =>
				board.seasonId === 2
					? new Map([['p-alice', { gamesPlayed: 30, rating: 1300 }]])
					: new Map([
							['p-alice', { gamesPlayed: 50, rating: 1250 }],
							['p-bob', { gamesPlayed: 12, rating: 760 }],
						]),
			topOfBoard: async () => [
				{ playerId: 'p-someone', rank: 1 },
				{ playerId: 'p-alice', rank: 2 },
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
					current: { gamesPlayed: 30, rating: 1300, rank: 2 },
					previous: { gamesPlayed: 50, rating: 1250 },
				},
				[BOB]: { current: null, previous: { gamesPlayed: 12, rating: 760 } },
			},
		})
	})

	it('reads the leaderboard on the current season and skips it for topN 0', async () => {
		const topOfBoard = vi.fn().mockResolvedValue([])
		const service = createStandingsService(deps({ topOfBoard }))
		await service.standings({ ...BOARD, topN: 50, discordIds: [ALICE] })
		expect(topOfBoard).toHaveBeenCalledWith({ ...BOARD, seasonId: 2 }, 50)
		topOfBoard.mockClear()
		await service.standings({ ...BOARD, topN: 0, discordIds: [ALICE] })
		expect(topOfBoard).not.toHaveBeenCalled()
	})

	it('has no previous standings in the first season', async () => {
		const boardRatings = vi.fn().mockResolvedValue(new Map())
		const service = createStandingsService(
			deps({ previousSeasonId: async () => null, boardRatings }),
		)
		const answer = await service.standings({
			...BOARD,
			topN: 0,
			discordIds: [BOB],
		})
		expect(answer.previousSeason).toBeNull()
		expect(answer.players[BOB]).toEqual({ current: null, previous: null })
		expect(boardRatings).toHaveBeenCalledTimes(1)
	})

	it('throws without an active season', async () => {
		const service = createStandingsService(
			deps({ currentSeasonId: async () => null }),
		)
		await expect(
			service.standings({ ...BOARD, topN: 0, discordIds: [] }),
		).rejects.toBeInstanceOf(NoActiveSeasonError)
	})
})
