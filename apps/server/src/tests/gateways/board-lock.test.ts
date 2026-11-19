import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BoardRebuildingError,
	readingStableBoard,
	whileRebuildingBoard,
} from '../../infrastructure/db/board-lock.js'
import { pool } from '../../infrastructure/db/index.js'

const BOARD = {
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
}
const KEY = 'board-rebuild:MultiplayerPvP:ranked:pvp_ranked_expanded'

// One fake connection; `sharedFree` is what pg_try_advisory_lock_shared says.
function fakeConnection(sharedFree = true) {
	const sql: string[] = []
	const client = {
		query: vi.fn(async (text: string, params: unknown[]) => {
			expect(params).toEqual([KEY])
			sql.push(text.replace(/\(hashtext\(\$1\)\).*/, ''))
			return { rows: [{ ok: sharedFree }] }
		}),
		release: vi.fn(),
	}
	;(pool as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(
		async () => client,
	)
	return { client, sql }
}

describe('board lock', () => {
	beforeEach(() => vi.clearAllMocks())

	it('holds the exclusive lock for the whole rebuild', async () => {
		const { client, sql } = fakeConnection()
		const result = await whileRebuildingBoard(BOARD, async () => {
			expect(sql).toEqual(['SELECT pg_advisory_lock'])
			return 'rebuilt'
		})
		expect(result).toBe('rebuilt')
		expect(sql).toEqual([
			'SELECT pg_advisory_lock',
			'SELECT pg_advisory_unlock',
		])
		expect(client.release).toHaveBeenCalledWith(undefined)
	})

	it('reads under a shared lock', async () => {
		const { sql } = fakeConnection()
		expect(await readingStableBoard(BOARD, async () => 42)).toBe(42)
		expect(sql).toEqual([
			'SELECT pg_try_advisory_lock_shared',
			'SELECT pg_advisory_unlock_shared',
		])
	})

	it('refuses to read while a rebuild holds the lock', async () => {
		const { client, sql } = fakeConnection(false)
		const read = vi.fn()
		await expect(readingStableBoard(BOARD, read)).rejects.toBeInstanceOf(
			BoardRebuildingError,
		)
		expect(read).not.toHaveBeenCalled()
		expect(sql).toEqual(['SELECT pg_try_advisory_lock_shared'])
		// A plain "busy" keeps the connection.
		expect(client.release).toHaveBeenCalledWith()
	})

	it('unlocks when the work fails', async () => {
		const { client, sql } = fakeConnection()
		await expect(
			whileRebuildingBoard(BOARD, async () => {
				throw new Error('replay failed')
			}),
		).rejects.toThrow('replay failed')
		expect(sql).toEqual([
			'SELECT pg_advisory_lock',
			'SELECT pg_advisory_unlock',
		])
		expect(client.release).toHaveBeenCalledWith(undefined)
	})

	it('destroys the connection if unlocking fails, dropping the lock', async () => {
		const { client } = fakeConnection()
		const broken = new Error('connection lost')
		client.query.mockImplementation(async (text: string) => {
			if (text.includes('unlock')) throw broken
			return { rows: [{ ok: true }] }
		})
		expect(await readingStableBoard(BOARD, async () => 'read')).toBe('read')
		expect(client.release).toHaveBeenCalledWith(broken)
	})
})
