import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../infrastructure/db/schema.js'
import {
	NO_PLAYER_ID_COLUMNS,
	PLAYER_ID_COLUMNS,
	anonymizationStatements,
} from '../../infrastructure/gateways/player-anonymization.gateway.js'
import { DELETED_PLAYER_ID } from '../../shared/deleted-player.js'

const OLD = '11111111-1111-4111-8111-111111111111'
const ANON = '99999999-9999-4999-8999-999999999999'

const dialect = new PgDialect()
// keptSteamIdHash: the hash the anonymous row keeps, or null. keptRunIds:
// the runs an open report or ban uses.
const render = (keptSteamIdHash: string | null, keptRunIds: string[] = []) =>
	anonymizationStatements(OLD, ANON, keptSteamIdHash, keptRunIds).map((s) => {
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

	it('sorts each player id column into own data, shared games or moderation data', () => {
		const dataOf = (name: string) =>
			PLAYER_ID_COLUMNS.find((c) => `${c.table}.${c.column}` === name)?.data
		for (const own of [
			'refresh_tokens.player_id',
			'player_mutes.muter_id',
			'player_mutes.muted_id',
			'chat_logs.player_id',
			'matchmaking_ratings.player_id',
			'leaderboard_cache.player_id',
			'grace_periods.player_id',
			'match_run_logs.player_id',
		])
			expect(dataOf(own), own).toBe('own')
		for (const shared of [
			'game_results.players',
			'game_results.result',
			'matchmaking_matches.players',
			'matchmaking_matches.result_placements',
		])
			expect(dataOf(shared), shared).toBe('shared')
		for (const moderation of [
			'reports.reporter_id',
			'reports.reported_id',
			'reported_lobby_messages.player_id',
			'flagged_messages.player_id',
			'player_bans.player_id',
			'player_warnings.player_id',
			'service_queue_items.subject_player_id',
			'match_result_conflicts.first_reporter_id',
			'forfeit_reconciliation_flags.player_id',
			'launcher_integrity_events.player_id',
		])
			expect(dataOf(moderation), moderation).toBe('moderation')
		// Own data goes by its rows, so only a plain id column can be own.
		for (const c of PLAYER_ID_COLUMNS)
			if (c.data === 'own') expect(c.kind, `${c.table}.${c.column}`).toBe('id')
	})
})

describe('anonymization statements', () => {
	it('replaces the players row: a new row first, the old one last', () => {
		const queries = render(null)
		const insert = queries.findIndex((q) =>
			q.sql.startsWith(
				'insert into "players" ("id", "steam_name", "steam_id_hash"',
			),
		)
		const remove = queries.findIndex((q) =>
			q.sql.startsWith('delete from "players"'),
		)
		const reports = queries.findIndex((q) =>
			q.sql.includes('update "reports" set "reported_id"'),
		)
		expect(insert).toBeGreaterThan(-1)
		expect(insert).toBeLessThan(reports)
		expect(reports).toBeLessThan(remove)
		expect(queries[remove].params).toEqual([OLD])
	})

	it("deletes the player's own data", () => {
		const queries = render(null)
		for (const table of [
			'refresh_tokens',
			'chat_logs',
			'matchmaking_ratings',
			'match_run_logs',
		])
			expect(queries).toContainEqual({
				sql: `delete from "${table}" where "player_id" = $1`,
				params: [OLD],
			})
		expect(queries).toContainEqual({
			sql: 'delete from "player_mutes" where "muter_id" = $1',
			params: [OLD],
		})
		expect(queries).toContainEqual({
			sql: 'delete from "player_mutes" where "muted_id" = $1',
			params: [OLD],
		})
	})

	it('gives shared games the one standard deleted-player id', () => {
		const queries = render(null)
		expect(queries).toContainEqual({
			sql: 'update "matchmaking_matches" set "players" = replace("players"::text, $1, $2)::jsonb where strpos("players"::text, $3) > 0',
			params: [OLD, DELETED_PLAYER_ID, OLD],
		})
		expect(queries).toContainEqual({
			sql: 'update "game_results" set "result" = replace("result"::text, $1, $2)::jsonb where strpos("result"::text, $3) > 0',
			params: [OLD, DELETED_PLAYER_ID, OLD],
		})
		expect(queries).toContainEqual({
			sql: 'insert into "players" ("id", "steam_name", "nakama_user_id", "deleted_at") values ($1, $2, $3, now()) on conflict do nothing',
			params: [DELETED_PLAYER_ID, '[deleted player]', DELETED_PLAYER_ID],
		})
	})

	it('keeps moderation data under the anonymous id', () => {
		const queries = render(null)
		expect(queries).toContainEqual({
			sql: 'update "reports" set "reported_id" = $1 where "reported_id" = $2',
			params: [ANON, OLD],
		})
		expect(queries).toContainEqual({
			sql: 'update "service_queue_items" set "source_id" = replace("source_id", $1, $2) where strpos("source_id", $3) > 0',
			params: [OLD, ANON, OLD],
		})
	})

	it('keeps flagged chat and the run logs an open report or ban uses, as moderation data', () => {
		const keptChat = {
			sql: 'update "chat_logs" set "player_id" = $1 where "player_id" = $2 and "flagged" = true',
			params: [ANON, OLD],
		}
		const queries = render(null, ['run-a', 'run-b'])
		const keptRuns = {
			sql: 'update "match_run_logs" set "player_id" = $1 where "player_id" = $2 and "run_id" in ($3, $4)',
			params: [ANON, OLD, 'run-a', 'run-b'],
		}
		expect(queries).toContainEqual(keptChat)
		expect(queries).toContainEqual(keptRuns)
		const at = (q: { sql: string }) => queries.findIndex((x) => x.sql === q.sql)
		expect(at(keptRuns)).toBeLessThan(
			at({ sql: 'delete from "match_run_logs" where "player_id" = $1' }),
		)
		expect(
			render(null).some((q) => q.sql.startsWith('update "match_run_logs"')),
		).toBe(false)
	})

	it('keeps the peppered Steam ID hash only for ban enforcement', () => {
		const insertOf = (kept: string | null) =>
			render(kept).find((q) =>
				q.sql.startsWith(
					'insert into "players" ("id", "steam_name", "steam_id_hash"',
				),
			)
		expect(insertOf('a'.repeat(64))?.params).toContain('a'.repeat(64))
		const clearsModerationId = (kept: string | null) =>
			render(kept).some((q) =>
				q.sql.startsWith('update "chat_logs" set "moderation_id" = null'),
			)
		expect(clearsModerationId(null)).toBe(true)
		expect(clearsModerationId('a'.repeat(64))).toBe(false)
	})
})
