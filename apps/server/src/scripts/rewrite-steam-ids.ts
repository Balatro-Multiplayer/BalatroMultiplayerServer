// One-time deploy step (ADR 0004): renames every Nakama account still named
// "steam:<raw Steam id>" to "steamhash:<hash>", with its ban index entry.
// Run it while Nakama is stopped, against Nakama's database, with the
// PLAYER_ID_SALT Nakama uses:
//   NAKAMA_DATABASE_URL=postgresql://.../nakama node dist/scripts/rewrite-steam-ids.js
// Exits 0 only when no raw-id login is left; start Nakama only then. Safe to
// run again: a second run moves nothing. The README's Deployment section
// has the Official server's commands.
import pg from 'pg'
import {
	createNakamaAccountGateway,
	otherDatabaseSessions,
} from '../infrastructure/gateways/nakama-account.gateway.js'
import { rewriteSteamIds } from '../features/nakama/steam-id-rewrite.service.js'
import { hashProviderId } from '../shared/utils/hash.js'

async function main(): Promise<number> {
	const url = process.env.NAKAMA_DATABASE_URL
	if (!url) {
		console.error('[steam-id-rewrite] NAKAMA_DATABASE_URL is not set')
		return 1
	}
	const pool = new pg.Pool({ connectionString: url })
	try {
		const others = await otherDatabaseSessions(pool)
		if (others > 0) {
			console.error(
				`[steam-id-rewrite] ${others} other session(s) on Nakama's database: stop Nakama first`,
			)
			return 1
		}
		const result = await rewriteSteamIds(
			createNakamaAccountGateway(pool),
			hashProviderId,
		)
		console.log(
			`[steam-id-rewrite] Renamed ${result.renamed} account(s), moved ${result.banKeysMoved} ban index entr(ies); ${result.left} raw-id login(s) left`,
		)
		return result.left === 0 ? 0 : 1
	} finally {
		await pool.end()
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(
			'[steam-id-rewrite] Failed (the rename is one transaction, so it is all or nothing):',
			err,
		)
		process.exit(1)
	})
