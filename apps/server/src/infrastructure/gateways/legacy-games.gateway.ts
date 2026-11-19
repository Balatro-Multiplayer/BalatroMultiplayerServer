import { and, count, desc, eq, isNotNull } from 'drizzle-orm'
import type {
	ILegacyGamesRepository,
	LegacyGameResult,
	LegacyGameRow,
} from '../../contracts/ILegacyGames.js'
import type { LegacyGameInsert } from '../../features/legacy-games/import-records.js'
import { shownNameOf } from '../../shared/players/shown-name.js'
import { db } from '../db/index.js'
import { legacyGameLogs, players } from '../db/schema.js'
import { hasActiveBan } from './ban.gateway.js'

const summaryCols = {
	id: legacyGameLogs.id,
	ownerName: legacyGameLogs.ownerName,
	opponentName: legacyGameLogs.opponentName,
	startedAt: legacyGameLogs.startedAt,
	endedAt: legacyGameLogs.endedAt,
	timeExact: legacyGameLogs.timeExact,
	result: legacyGameLogs.result,
	deck: legacyGameLogs.deck,
	stake: legacyGameLogs.stake,
	seed: legacyGameLogs.seed,
	betaSeason: legacyGameLogs.betaSeason,
	betaMatchKey: legacyGameLogs.betaMatchKey,
	sharedAt: legacyGameLogs.sharedAt,
}

export const legacyGamesRepository: ILegacyGamesRepository = {
	async getGame(id) {
		const [row] = await db
			.select()
			.from(legacyGameLogs)
			.where(eq(legacyGameLogs.id, id))
			.limit(1)
		return row
			? { ...row, result: row.result as LegacyGameResult | null }
			: null
	},

	async discordHashOf(playerId) {
		const [row] = await db
			.select({ hash: players.discordIdHash, deletedAt: players.deletedAt })
			.from(players)
			.where(eq(players.id, playerId))
			.limit(1)
		return row && !row.deletedAt ? (row.hash ?? null) : null
	},

	async accountOf(discordIdHash) {
		const [p] = await db
			.select()
			.from(players)
			.where(eq(players.discordIdHash, discordIdHash))
			.limit(1)
		if (!p || p.deletedAt) return null
		return {
			playerId: p.id,
			displayName: shownNameOf(p, await hasActiveBan(p.id, 'username')),
		}
	},

	async setShared(id, discordIdHash, shared) {
		const rows = await db
			.update(legacyGameLogs)
			.set({ sharedAt: shared ? new Date() : null })
			.where(
				and(
					eq(legacyGameLogs.id, id),
					eq(legacyGameLogs.discordIdHash, discordIdHash),
				),
			)
			.returning({ id: legacyGameLogs.id })
		return rows.length > 0
	},

	async countForOwner(discordIdHash) {
		const [row] = await db
			.select({ n: count() })
			.from(legacyGameLogs)
			.where(eq(legacyGameLogs.discordIdHash, discordIdHash))
		return row?.n ?? 0
	},

	async pageForOwner(discordIdHash, pageSize, offset) {
		const rows = await db
			.select(summaryCols)
			.from(legacyGameLogs)
			.where(eq(legacyGameLogs.discordIdHash, discordIdHash))
			.orderBy(desc(legacyGameLogs.startedAt), desc(legacyGameLogs.id))
			.limit(pageSize)
			.offset(offset)
		return rows.map(({ sharedAt, ...r }) => ({
			...r,
			result: r.result as LegacyGameResult | null,
			shared: sharedAt !== null,
		}))
	},
}

const INSERT_BATCH = 500

// The import's one write: the table replaced in one transaction, so a failed
// run changes nothing. Shares made since the last import are kept.
export async function replaceLegacyGames(
	rows: AsyncIterable<LegacyGameInsert>,
): Promise<number> {
	let n = 0
	await db.transaction(async (tx) => {
		const shared = await tx
			.select({ id: legacyGameLogs.id, sharedAt: legacyGameLogs.sharedAt })
			.from(legacyGameLogs)
			.where(isNotNull(legacyGameLogs.sharedAt))
		const sharedAt = new Map(shared.map((r) => [r.id, r.sharedAt]))
		await tx.delete(legacyGameLogs)
		let batch: LegacyGameInsert[] = []
		const flush = async () => {
			if (batch.length) await tx.insert(legacyGameLogs).values(batch)
			n += batch.length
			batch = []
		}
		for await (const row of rows) {
			batch.push({ ...row, sharedAt: sharedAt.get(row.id) ?? null })
			if (batch.length >= INSERT_BATCH) await flush()
		}
		await flush()
	})
	return n
}
