import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../infrastructure/db/schema.js'
import {
	NO_PLAYER_ID_COLUMNS,
	PLAYER_ID_COLUMNS,
	anonymizationStatements,
} from '../../infrastructure/gateways/player-anonymization.gateway.js'

const OLD = '11111111-1111-4111-8111-111111111111'
const ANON = '99999999-9999-4999-8999-999999999999'

const dialect = new PgDialect()
// keptSteamIdHash: the hash the anonymous row keeps, or null.
const render = (keptSteamIdHash: string | null) =>
	anonymizationStatements(OLD, ANON, keptSteamIdHash).map((s) => {
		const { sql, params } = dialect.sqlToQuery(s)
		return { sql, params }
	})

function schemaColumns(): string[] {
	const names: string[] = []
	for (const value of Object.values(schema)) {
		if (!(value instanceof PgTable)) continue
		const config = getTableConfig(value)
		for (const column of config.columns)
			names.push(`${config.name}.${column.name}`)
	}
	return names
}

describe('player id columns', () => {
	it('classifies every column of every table, so a new one is not missed', () => {
		const classified = [
			...PLAYER_ID_COLUMNS.map((c) => `${c.table}.${c.column}`),
			...NO_PLAYER_ID_COLUMNS,
		]
		const unclassified = schemaColumns().filter((c) => !classified.includes(c))
		expect(unclassified).toEqual([])
		expect(classified.filter((c) => !schemaColumns().includes(c))).toEqual([])
		expect(new Set(classified).size).toBe(classified.length)
	})
})

describe('anonymization statements', () => {
	it('replaces the players row: a new row first, the old one last', () => {
		const queries = render(null)
		const insert = queries.findIndex((q) =>
			q.sql.startsWith('insert into "players"'),
		)
		const remove = queries.findIndex((q) =>
			q.sql.startsWith('delete from "players"'),
		)
		const ratings = queries.findIndex((q) =>
			q.sql.includes('update "matchmaking_ratings"'),
		)
		expect(insert).toBeGreaterThan(-1)
		expect(insert).toBeLessThan(ratings)
		expect(ratings).toBeLessThan(remove)
		expect(queries[remove].params).toEqual([OLD])
	})

	it('moves a plain id column and rewrites ids inside text and JSON', () => {
		const queries = render(null)
		expect(queries).toContainEqual({
			sql: 'update "chat_logs" set "player_id" = $1 where "player_id" = $2',
			params: [ANON, OLD],
		})
		expect(queries).toContainEqual({
			sql: 'update "matchmaking_matches" set "players" = replace("players"::text, $1, $2)::jsonb where strpos("players"::text, $3) > 0',
			params: [OLD, ANON, OLD],
		})
		expect(queries).toContainEqual({
			sql: 'update "service_queue_items" set "source_id" = replace("source_id", $1, $2) where strpos("source_id", $3) > 0',
			params: [OLD, ANON, OLD],
		})
	})

	it('drops what only served the deleted player', () => {
		const queries = render(null)
		expect(queries).toContainEqual({
			sql: 'delete from "player_mutes" where "muter_id" = $1',
			params: [OLD],
		})
		expect(queries).toContainEqual({
			sql: 'delete from "refresh_tokens" where "player_id" = $1',
			params: [OLD],
		})
	})

	it('keeps the peppered Steam ID hash only for ban enforcement', () => {
		const insertOf = (kept: string | null) =>
			render(kept).find((q) => q.sql.startsWith('insert into "players"'))
		expect(insertOf('a'.repeat(64))?.params).toContain('a'.repeat(64))
		const clearsModerationId = (kept: string | null) =>
			render(kept).some((q) =>
				q.sql.startsWith('update "chat_logs" set "moderation_id" = null'),
			)
		expect(clearsModerationId(null)).toBe(true)
		expect(clearsModerationId('a'.repeat(64))).toBe(false)
	})
})
