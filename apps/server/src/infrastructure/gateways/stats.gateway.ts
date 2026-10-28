import { sql } from 'drizzle-orm'
import type { IStatsRepository } from '../../contracts/IStatsSources.js'
import { db } from '../db/index.js'
import { matchmakingMatches, players } from '../db/schema.js'

export const statsRepository: IStatsRepository = {
	async countTotals() {
		const [matchRow, playerRow] = await Promise.all([
			db.select({ total: sql<number>`count(*)::int` }).from(matchmakingMatches),
			db.select({ total: sql<number>`count(*)::int` }).from(players),
		])
		return {
			matches: matchRow[0]?.total ?? 0,
			players: playerRow[0]?.total ?? 0,
		}
	},
}
