import { sql } from 'drizzle-orm'
import type { DbTransaction } from './executor.js'

// A void's board rebuild and a season replay wipe rating rows and write them
// again (a rewrite). Without these locks a rewrite's wipe can't see rows
// written while it runs: a second rewrite, or a player's first row, gets every
// match replayed on top of it (double counts) or fails on a duplicate key, and
// an edit to a row the wipe deleted changes nothing.
//
// So a rewrite runs alone on what it rewrites, and every other rating write
// (the mirror, staff match edits) waits for a rewrite of its board only:
//   season replay   season key, exclusive
//   board rebuild   season key, shared; board key, exclusive
//   rating write    season keys, shared; board keys, shared
// Take them as the transaction's first statements, before any row lock. Every
// path takes season keys before board keys, each in sorted order, so two
// transactions never wait on each other.

export interface RatingBoard {
	season: number
	modId: string
	gameMode: string
}

const seasonKey = (season: number) => `season-ratings:${season}`
const boardKey = (b: RatingBoard) =>
	`board-ratings:${b.season}:${b.modId}:${b.gameMode}`

async function lock(
	tx: DbTransaction,
	key: string,
	shared: boolean,
): Promise<void> {
	await tx.execute(
		shared
			? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
			: sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
	)
}

export async function lockSeasonForRewrite(
	tx: DbTransaction,
	season: number,
): Promise<void> {
	await lock(tx, seasonKey(season), false)
}

export async function lockBoardForRewrite(
	tx: DbTransaction,
	board: RatingBoard,
): Promise<void> {
	await lock(tx, seasonKey(board.season), true)
	await lock(tx, boardKey(board), false)
}

export async function lockBoardsForWrite(
	tx: DbTransaction,
	boards: RatingBoard[],
): Promise<void> {
	const seasons = [...new Set(boards.map((b) => b.season))]
	for (const season of seasons.sort((a, b) => a - b))
		await lock(tx, seasonKey(season), true)
	for (const key of [...new Set(boards.map(boardKey))].sort())
		await lock(tx, key, true)
}
