import { describe, expect, it, vi } from 'vitest'
import type {
	ILegacyGamesRepository,
	LegacyGameRow,
} from '../../contracts/ILegacyGames.js'
import type { IModeratorLookup } from '../../contracts/IModeratorLookup.js'
import {
	LEGACY_OPPONENT_ID,
	LEGACY_OWNER_ID,
	createLegacyGamesService,
} from '../../features/legacy-games/legacy-games.service.js'
import {
	compressToBase64,
	decompressFromBase64,
} from '../../shared/utils/compression.js'

const ownerEvents = compressToBase64(
	JSON.stringify([
		[0, 'run_info', { seed: 'ABC', deck: 'Red Deck' }],
		[1, 'select_blind', [0, 'bl_mp_nemesis']],
		[2, 'play', [[1, 2], []]],
		[3, 'hand_result', ['300', 3]],
		[4, 'end', { result: 'win' }],
	]),
)
const opponentEvents = compressToBase64(
	JSON.stringify([
		[1, 'select_blind', [0, 'bl_mp_nemesis']],
		[3, 'hand_result', ['200', 0]],
		[4, 'final_jokers', [['j_joker']]],
		[4, 'end', { result: 'loss' }],
	]),
)

function game(overrides: Partial<LegacyGameRow> = {}): LegacyGameRow {
	return {
		id: 7,
		discordIdHash: 'hash-a',
		ownerName: 'Old Name',
		opponentName: 'Rival',
		startedAt: new Date('2025-06-21T19:20:00Z'),
		endedAt: new Date('2025-06-21T19:40:00Z'),
		timeExact: true,
		result: 'win',
		deck: 'Red Deck',
		stake: null,
		seed: 'ABC',
		betaSeason: 4,
		betaMatchKey: 'm-1',
		ownerEvents,
		opponentEvents,
		sharedAt: null,
		...overrides,
	}
}

function setup(
	row: LegacyGameRow | null,
	opts: { hashes?: Record<string, string>; moderators?: string[] } = {},
) {
	const hashes = opts.hashes ?? {}
	const repository: ILegacyGamesRepository = {
		getGame: vi.fn(async () => row),
		discordHashOf: vi.fn(async (id: string) => hashes[id] ?? null),
		accountOf: vi.fn(async (hash: string) => {
			const id = Object.keys(hashes).find((k) => hashes[k] === hash)
			return id ? { playerId: id, displayName: 'Live Name' } : null
		}),
		setShared: vi.fn(async (_id, hash) => hash === 'hash-a'),
		countForOwner: vi.fn(async () => 1),
		pageForOwner: vi.fn(async () => []),
	}
	const moderators: IModeratorLookup = {
		isModerator: vi.fn(async (id: string) =>
			(opts.moderators ?? []).includes(id),
		),
	}
	return {
		repository,
		service: createLegacyGamesService({ repository, moderators }),
	}
}

const eventsOf = (block: string) =>
	(JSON.parse(decompressFromBase64(block)) as [number, string][]).map(
		(e) => e[1],
	)

describe('legacy-games.service getGame', () => {
	it('gives the owner both sides in full, under their live account', async () => {
		const { service } = setup(game(), { hashes: { p1: 'hash-a' } })
		const res = await service.getGame(7, 'p1')
		expect(res.viewer).toEqual({ role: 'participant', playerId: 'p1' })
		expect(res.logs.map((l) => [l.playerId, l.displayName, l.hidden])).toEqual([
			['p1', 'Live Name', false],
			[LEGACY_OPPONENT_ID, 'Rival', false],
		])
		expect(res.logs[1]?.compressedEvents).toBe(opponentEvents)
		expect(res.legacy).toMatchObject({
			id: 7,
			beta: { season: 4, matchKey: 'm-1' },
		})
		expect(res.run).toMatchObject({
			id: '7',
			lobbyCode: null,
			status: 'completed',
		})
	})

	it('answers 404 to a public viewer of a game that is not shared', async () => {
		const { service } = setup(game(), {
			hashes: { p1: 'hash-a', p2: 'hash-b' },
		})
		await expect(service.getGame(7, null)).rejects.toMatchObject({
			statusCode: 404,
		})
		await expect(service.getGame(7, 'p2')).rejects.toMatchObject({
			statusCode: 404,
		})
	})

	it('answers 404 for a game that does not exist', async () => {
		const { service } = setup(null)
		await expect(service.getGame(7, null)).rejects.toMatchObject({
			statusCode: 404,
		})
	})

	it('shows a shared game to the public with the opponent reduced to the result', async () => {
		const { service } = setup(game({ sharedAt: new Date() }))
		const res = await service.getGame(7, null)
		expect(res.viewer).toEqual({ role: 'public' })
		const [owner, opponent] = res.logs
		if (!opponent) throw new Error('no opponent side')
		expect(owner).toMatchObject({
			playerId: LEGACY_OWNER_ID,
			displayName: 'Old Name',
			shared: true,
			hidden: false,
		})
		expect(opponent).toMatchObject({ hidden: true, shared: false })
		expect(eventsOf(opponent.compressedEvents)).not.toContain('final_jokers')
		expect(eventsOf(opponent.compressedEvents)).toContain('hand_result')
	})

	it('shows a moderator the whole game', async () => {
		const { service } = setup(game(), { moderators: ['mod'] })
		const res = await service.getGame(7, 'mod')
		expect(res.viewer.role).toBe('moderator')
		expect(res.logs.every((l) => !l.hidden)).toBe(true)
	})

	it('treats a game with no uploader link as nobody’s', async () => {
		const { service } = setup(game({ discordIdHash: null }), {
			hashes: { p1: 'hash-a' },
		})
		await expect(service.getGame(7, 'p1')).rejects.toMatchObject({
			statusCode: 404,
		})
	})
})

describe('legacy-games.service setShared and listMine', () => {
	it('lets only the owner share', async () => {
		const { service, repository } = setup(game(), {
			hashes: { p1: 'hash-a', p2: 'hash-b' },
		})
		await service.setShared(7, 'p1', true)
		expect(repository.setShared).toHaveBeenCalledWith(7, 'hash-a', true)
		await expect(service.setShared(7, 'p2', true)).rejects.toMatchObject({
			statusCode: 404,
		})
		await expect(service.setShared(7, 'p3', true)).rejects.toMatchObject({
			statusCode: 404,
		})
	})

	it('lists nothing for a player with no Discord link', async () => {
		const { service, repository } = setup(game())
		expect(await service.listMine('p3', 1, 20)).toEqual({
			games: [],
			total: 0,
			page: 1,
			pageSize: 20,
		})
		expect(repository.pageForOwner).not.toHaveBeenCalled()
	})

	it('pages the owner’s games', async () => {
		const { service, repository } = setup(game(), { hashes: { p1: 'hash-a' } })
		await service.listMine('p1', 3, 20)
		expect(repository.pageForOwner).toHaveBeenCalledWith('hash-a', 20, 40)
	})
})
