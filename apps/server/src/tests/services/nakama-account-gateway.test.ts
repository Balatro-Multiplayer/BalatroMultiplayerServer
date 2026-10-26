import { describe, expect, it } from 'vitest'
import { createNakamaAccountGateway } from '../../infrastructure/gateways/nakama-account.gateway.js'

const plan = {
	accounts: [{ userId: '11111111-1111-4111-8111-111111111111', customId: `steamhash:${'a'.repeat(64)}` }],
	banKeys: [],
}

// A pg pool whose one client records its statements; `others` is how many
// other sessions pg_stat_activity shows.
function fakePool(others: number) {
	const statements: string[] = []
	const client = {
		async query(text: string) {
			statements.push(text.replace(/\s+/g, ' ').trim())
			if (text.includes('pg_stat_activity')) return { rows: [{ n: String(others) }] }
			return { rows: [] }
		},
		release() {},
	}
	return { pool: { connect: async () => client } as never, statements }
}

describe("the Steam id rewrite on Nakama's database", () => {
	it('locks the tables, then rechecks for other sessions inside the transaction, so Nakama cannot start during the run', async () => {
		const { pool, statements } = fakePool(0)
		await createNakamaAccountGateway(pool).applySteamIdRewrite(plan)
		const lock = statements.findIndex((s) => /^LOCK TABLE users, storage IN ACCESS EXCLUSIVE MODE/.test(s))
		const check = statements.findIndex((s) => s.includes('pg_stat_activity'))
		const update = statements.findIndex((s) => s.startsWith('UPDATE users'))
		expect(statements[0]).toBe('BEGIN')
		expect(lock).toBeGreaterThan(0)
		expect(check).toBeGreaterThan(lock)
		expect(update).toBeGreaterThan(check)
		expect(statements[statements.length - 1]).toBe('COMMIT')
	})

	it('changes nothing when another session is on the database', async () => {
		const { pool, statements } = fakePool(1)
		await expect(createNakamaAccountGateway(pool).applySteamIdRewrite(plan)).rejects.toThrow(/other session/)
		expect(statements.some((s) => s.startsWith('UPDATE'))).toBe(false)
		expect(statements[statements.length - 1]).toBe('ROLLBACK')
	})
})
