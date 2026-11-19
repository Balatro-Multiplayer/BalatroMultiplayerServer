import { pool } from './index.js'

// A void or result change (void-match.ts rebuildScope) deletes a board's
// rating rows and replays its matches. Readers that act on the board (the
// Discord rank-role bot) must not see it half built: they would take roles
// from players whose rows aren't back yet.
//
// A Postgres advisory lock per board (modId, gameMode, any season): the
// rebuild holds it exclusively, a reader shared. The lock lives in Postgres,
// so it also covers a rebuild run from the void-match.ts command line.

export class BoardRebuildingError extends Error {
	constructor() {
		super('The board is being rebuilt; try again shortly')
	}
}

export interface Board {
	modId: string
	gameMode: string
}

const keyOf = (board: Board) => `board-rebuild:${board.modId}:${board.gameMode}`

// Holds the lock on its own connection for the whole of `body` (which runs
// its queries on the pool as usual), then unlocks. If locking or unlocking
// fails the connection is destroyed, and a held session lock goes with it.
async function holdingLock<T>(
	board: Board,
	mode: 'exclusive' | 'shared',
	body: () => Promise<T>,
): Promise<T> {
	const key = keyOf(board)
	const client = await pool.connect()
	let locked: boolean
	try {
		if (mode === 'exclusive') {
			await client.query('SELECT pg_advisory_lock(hashtext($1))', [key])
			locked = true
		} else {
			const { rows } = await client.query<{ ok: boolean }>(
				'SELECT pg_try_advisory_lock_shared(hashtext($1)) AS ok',
				[key],
			)
			locked = rows[0]?.ok === true
		}
	} catch (err) {
		client.release(err as Error)
		throw err
	}
	if (!locked) {
		client.release()
		throw new BoardRebuildingError()
	}
	let broken: Error | undefined
	try {
		return await body()
	} finally {
		const unlock =
			mode === 'exclusive'
				? 'SELECT pg_advisory_unlock(hashtext($1))'
				: 'SELECT pg_advisory_unlock_shared(hashtext($1))'
		await client.query(unlock, [key]).catch((err: Error) => {
			broken = err
		})
		client.release(broken)
	}
}

/** Runs `rebuild` holding the board's lock; waits for readers to finish. */
export function whileRebuildingBoard<T>(
	board: Board,
	rebuild: () => Promise<T>,
): Promise<T> {
	return holdingLock(board, 'exclusive', rebuild)
}

/**
 * Runs `read` while no rebuild of the board can start. Throws
 * BoardRebuildingError at once if one is running.
 */
export function readingStableBoard<T>(
	board: Board,
	read: () => Promise<T>,
): Promise<T> {
	return holdingLock(board, 'shared', read)
}
