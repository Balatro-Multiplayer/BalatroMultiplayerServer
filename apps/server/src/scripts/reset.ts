// compose.local.yml's `reset` service: `docker compose -f compose.local.yml
// run --rm reset`. Empties both databases (features/local-server/reset.ts);
// restart Nakama and the API afterwards.
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { env } from '../env.js'
import { runReset } from '../features/local-server/reset.js'
import { db, pool } from '../infrastructure/db/index.js'

const NAKAMA_DATABASE = process.env.NAKAMA_DATABASE || 'nakama'

// Database names come from our own config, never from a player, but quote
// them anyway: CREATE/DROP DATABASE take no bind parameters.
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`

async function main() {
	const apiUrl = new URL(env.DATABASE_URL)
	const apiDatabase = decodeURIComponent(apiUrl.pathname.replace(/^\//, ''))
	const maintenanceUrl = new URL(env.DATABASE_URL)
	maintenanceUrl.pathname = '/postgres'
	const admin = new pg.Client({ connectionString: maintenanceUrl.toString() })
	await admin.connect()

	const result = await runReset({
		kind: env.BMP_SERVER_KIND,
		apiDatabase,
		nakamaDatabase: NAKAMA_DATABASE,
		dropDatabase: async (name) => {
			console.log(`[reset] Dropping ${name}`)
			await admin.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`)
		},
		createDatabase: async (name) => {
			await admin.query(`CREATE DATABASE ${quoted(name)}`)
		},
		migrate: async () => {
			console.log('[reset] Migrating')
			await migrate(db, { migrationsFolder: './drizzle' })
		},
	})
	await admin.end()
	await pool.end()
	if (!result.ok) {
		console.error(
			'[reset] Refusing to reset the Official server (BMP_SERVER_KIND=official).',
		)
		process.exit(1)
	}
	console.log(
		'[reset] Done. Now restart Nakama and the API: docker compose -f compose.local.yml restart',
	)
	process.exit(0)
}

main().catch((e) => {
	console.error('[reset] Failed:', e)
	process.exit(1)
})
