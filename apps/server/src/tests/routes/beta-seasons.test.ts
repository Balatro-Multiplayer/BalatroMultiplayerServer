import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { IBetaSeasonsRepository } from '../../contracts/IBetaSeasons.js'
import { createBetaSeasonsRouter } from '../../features/beta-seasons/beta-seasons.route.js'
import { errorHandler } from '../../middleware/errorHandler.js'

const BOARD = {
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
}

function appWith(overrides: Partial<IBetaSeasonsRepository> = {}) {
	const repo: IBetaSeasonsRepository = {
		listSeasons: vi.fn(async () => []),
		countBoard: vi.fn(async () => 0),
		boardPage: vi.fn(async () => []),
		discordHashOf: vi.fn(async () => null),
		standingsOf: vi.fn(async () => []),
		countGames: vi.fn(async () => 0),
		gamesPage: vi.fn(async () => []),
		...overrides,
	}
	const app = express()
	app.use(
		'/api/stats/beta-seasons',
		createBetaSeasonsRouter({ betaSeasonsRepository: repo }),
	)
	app.use(errorHandler)
	return { app, repo }
}

describe('Beta Seasons routes', () => {
	it('lists the seasons with their boards', async () => {
		const { app } = appWith({
			listSeasons: vi.fn(async () => [
				{
					number: 7,
					name: 'Beta Season 7',
					startedAt: null,
					endedAt: null,
					boards: [{ ...BOARD, entries: 9 }],
				},
			]),
		})
		const res = await request(app).get('/api/stats/beta-seasons')
		expect(res.status).toBe(200)
		expect(res.body.seasons[0]).toMatchObject({
			number: 7,
			boards: [{ ...BOARD, entries: 9 }],
		})
	})

	it('pages a board and passes the search on', async () => {
		const { app, repo } = appWith({
			countBoard: vi.fn(async () => 250),
			boardPage: vi.fn(async () => [
				{
					rank: 101,
					playerId: null,
					displayName: 'Legacy Name',
					rating: 400,
					peakRating: 450,
					wins: 10,
					losses: 5,
					gamesPlayed: 15,
				},
			]),
		})
		const res = await request(app)
			.get('/api/stats/beta-seasons/3/leaderboard')
			.query({ ...BOARD, page: 2, search: ' bob ' })
		expect(res.status).toBe(200)
		expect(res.body).toMatchObject({
			season: 3,
			page: 2,
			total: 250,
			totalPages: 3,
		})
		expect(res.body.entries[0]).toMatchObject({
			playerId: null,
			displayName: 'Legacy Name',
		})
		expect(repo.boardPage).toHaveBeenCalledWith(
			{ season: 3, ...BOARD, term: '%bob%' },
			100,
			100,
		)
	})

	it('refuses a bad season or a missing board', async () => {
		const { app } = appWith()
		expect(
			(
				await request(app)
					.get('/api/stats/beta-seasons/zero/leaderboard')
					.query(BOARD)
			).status,
		).toBe(400)
		expect(
			(
				await request(app)
					.get('/api/stats/beta-seasons/2/leaderboard')
					.query({ modId: BOARD.modId })
			).status,
		).toBe(400)
	})

	it('gives a player with no Discord link no history', async () => {
		const { app, repo } = appWith()
		const res = await request(app).get('/api/stats/beta-seasons/players/p-1')
		expect(res.body).toEqual({ linked: false, standings: [] })
		expect(repo.standingsOf).not.toHaveBeenCalled()

		const games = await request(app)
			.get('/api/stats/beta-seasons/players/p-1/games')
			.query({ ...BOARD, season: 2 })
		expect(games.body).toMatchObject({ total: 0, games: [] })
		expect(repo.gamesPage).not.toHaveBeenCalled()
	})

	it('reads a linked player by their Discord hash', async () => {
		const { app, repo } = appWith({
			discordHashOf: vi.fn(async () => 'abc'),
			standingsOf: vi.fn(async () => [
				{
					season: 4,
					seasonName: 'Beta Season 4',
					...BOARD,
					rank: 2,
					boardSize: 4547,
					rating: 1212,
					peakRating: 1240,
					wins: 105,
					losses: 44,
					gamesPlayed: 149,
				},
			]),
			countGames: vi.fn(async () => 149),
		})
		const res = await request(app).get('/api/stats/beta-seasons/players/p-1')
		expect(res.body.linked).toBe(true)
		expect(res.body.standings[0]).toMatchObject({ season: 4, rank: 2 })
		expect(repo.standingsOf).toHaveBeenCalledWith('abc')

		const games = await request(app)
			.get('/api/stats/beta-seasons/players/p-1/games')
			.query({ ...BOARD, season: 4, page: 3 })
		expect(games.body).toMatchObject({ page: 3, total: 149, totalPages: 6 })
		expect(repo.gamesPage).toHaveBeenCalledWith(
			{ discordIdHash: 'abc', season: 4, ...BOARD, ownView: false },
			25,
			50,
		)
	})
})
