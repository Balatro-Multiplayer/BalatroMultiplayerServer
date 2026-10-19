// Migration 0049 resets players.preferred_joker by the same rule as Nakama's
// admin_avatars_reset (keepsJoker); this keeps its hand-written lists in step
// with the catalog.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../../../../nakama/src/shared/avatars/catalog'

const sql = readFileSync(path.join(import.meta.dirname, '../../../drizzle/0049_reset_preferred_jokers.sql'), 'utf8')

describe('avatar reset migration', () => {
	it('keeps exactly the default jokers', () => {
		const defaults = CATALOG.filter((e) => e.rule.kind === 'default').map((e) => e.id)
		const kept = sql.slice(sql.indexOf('NOT IN ('), sql.indexOf(')', sql.indexOf('NOT IN (')))
		expect(kept.match(/j_[a-z_]+/g)?.sort()).toEqual(defaults.sort())
	})

	it('keeps exactly the privilege jokers, for their privilege', () => {
		const granted: string[] = []
		for (const e of CATALOG) {
			if (e.rule.kind === 'privilege') granted.push(`${e.id}:${e.rule.privilege}`)
			if (e.alsoGrantedBy) granted.push(`${e.id}:${e.alsoGrantedBy}`)
		}
		const inSql: string[] = []
		for (const m of sql.matchAll(/"preferred_joker" = '(j_[a-z_]+)'\s+AND '([a-z]+)'/g)) inSql.push(`${m[1]}:${m[2]}`)
		for (const m of sql.matchAll(/"preferred_joker" IN \(([^)]*)\) AND '([a-z]+)'/g))
			for (const id of m[1].match(/j_[a-z_]+/g) ?? []) inSql.push(`${id}:${m[2]}`)
		expect(inSql.sort()).toEqual(granted.sort())
	})
})
