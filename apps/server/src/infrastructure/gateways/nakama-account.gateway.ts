// Nakama's own database (not the API's), for the Steam id rewrite only.
// Nakama keeps the custom id in users.custom_id and the ban index as
// system-owned storage objects in collection "ban_index"
// (nakama/src/moderation/enforce.ts).
import type pg from 'pg'
import type {
	INakamaAccountRepository,
	RawSteamLogins,
	SteamIdRewritePlan,
} from '../../contracts/INakamaAccountRepository.js'

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'
const BAN_INDEX_COLLECTION = 'ban_index'
const RAW_CUSTOM_ID_PREFIX = 'steam:'
const RAW_BAN_KEY_PREFIX = 'custom:steam:'
const RAW_CUSTOM_ID = '^steam:[0-9]+$'
const RAW_BAN_KEY = '^custom:steam:[0-9]+$'
const UPDATE_BATCH = 1000

export function createNakamaAccountGateway(
	pool: pg.Pool,
): INakamaAccountRepository {
	async function findRawSteamLogins(): Promise<RawSteamLogins> {
		const users = await pool.query<{ id: string; custom_id: string }>(
			'SELECT id::text AS id, custom_id FROM users WHERE custom_id ~ $1',
			[RAW_CUSTOM_ID],
		)
		const bans = await pool.query<{ key: string }>(
			'SELECT key FROM storage WHERE collection = $1 AND user_id = $2 AND key ~ $3',
			[BAN_INDEX_COLLECTION, SYSTEM_USER_ID, RAW_BAN_KEY],
		)
		return {
			accounts: users.rows.map((row) => ({
				userId: row.id,
				steamId: row.custom_id.slice(RAW_CUSTOM_ID_PREFIX.length),
			})),
			bannedSteamIds: bans.rows.map((row) =>
				row.key.slice(RAW_BAN_KEY_PREFIX.length),
			),
		}
	}

	async function applySteamIdRewrite(plan: SteamIdRewritePlan): Promise<void> {
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			// The script checked for a running Nakama before it read; one that
			// starts since then would write under the rename. The lock makes any
			// Nakama wait for the commit, and the check under it refuses to go on
			// if one connected in between.
			await client.query('LOCK TABLE users, storage IN ACCESS EXCLUSIVE MODE')
			const others = await countOtherSessions(client)
			if (others > 0)
				throw new Error(
					`${others} other session(s) on Nakama's database: stop Nakama first`,
				)
			for (let i = 0; i < plan.accounts.length; i += UPDATE_BATCH) {
				const batch = plan.accounts.slice(i, i + UPDATE_BATCH)
				await client.query(
					`UPDATE users AS u SET custom_id = v.custom_id, update_time = now()
					 FROM unnest($1::uuid[], $2::text[]) AS v(id, custom_id)
					 WHERE u.id = v.id`,
					[batch.map((a) => a.userId), batch.map((a) => a.customId)],
				)
			}
			for (const { from, to } of plan.banKeys) {
				// An entry already under the hashed key is newer; keep it.
				await client.query(
					`UPDATE storage SET key = $4, update_time = now()
					 WHERE collection = $1 AND user_id = $2 AND key = $3
					 AND NOT EXISTS (SELECT 1 FROM storage WHERE collection = $1 AND user_id = $2 AND key = $4)`,
					[BAN_INDEX_COLLECTION, SYSTEM_USER_ID, from, to],
				)
				await client.query(
					'DELETE FROM storage WHERE collection = $1 AND user_id = $2 AND key = $3',
					[BAN_INDEX_COLLECTION, SYSTEM_USER_ID, from],
				)
			}
			await client.query('COMMIT')
		} catch (err) {
			await client.query('ROLLBACK')
			throw err
		} finally {
			client.release()
		}
	}

	async function countRawSteamLogins(): Promise<number> {
		const result = await pool.query<{ left: string }>(
			`SELECT (SELECT count(*) FROM users WHERE custom_id ~ $1)
			      + (SELECT count(*) FROM storage WHERE collection = $2 AND user_id = $3 AND key ~ $4) AS left`,
			[RAW_CUSTOM_ID, BAN_INDEX_COLLECTION, SYSTEM_USER_ID, RAW_BAN_KEY],
		)
		return Number(result.rows[0].left)
	}

	return { findRawSteamLogins, applySteamIdRewrite, countRawSteamLogins }
}

async function countOtherSessions(
	db: Pick<pg.Pool | pg.PoolClient, 'query'>,
): Promise<number> {
	const result = await db.query<{ n: string }>(
		'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
	)
	return Number(result.rows[0].n)
}

// Other sessions on Nakama's database: a running Nakama holds a pool open.
export function otherDatabaseSessions(pool: pg.Pool): Promise<number> {
	return countOtherSessions(pool)
}
