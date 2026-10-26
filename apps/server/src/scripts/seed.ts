// compose.local.yml's `seed` service: `docker compose -f compose.local.yml
// run --rm seed`. Makes the test players and the web admin login
// (features/local-server/seed.ts) and prints them.
import { env } from '../env.js'
import { signJwt } from '../features/auth/jwt.js'
import { runSeed } from '../features/local-server/seed.js'
import { pool } from '../infrastructure/db/index.js'
import { upsertAdminPlayer } from '../infrastructure/gateways/player.gateway.js'
import { type Result, err, ok } from '../shared/utils/result.js'

const NAKAMA_SERVER_KEY = process.env.NAKAMA_SERVER_KEY || 'defaultkey'

// A Device login through Nakama's public API, as the Dev mod does it.
async function createTestPlayer(player: {
	deviceId: string
	username: string
}): Promise<Result<{ userId: string }, string>> {
	try {
		const auth = await fetch(
			`${env.NAKAMA_URL}/v2/account/authenticate/device?create=true&username=${encodeURIComponent(player.username)}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Basic ${Buffer.from(`${NAKAMA_SERVER_KEY}:`).toString('base64')}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: player.deviceId }),
			},
		)
		if (!auth.ok)
			return err(`device login: HTTP ${auth.status} ${await auth.text()}`)
		const { token } = (await auth.json()) as { token: string }
		const account = await fetch(`${env.NAKAMA_URL}/v2/account`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		if (!account.ok) return err(`account: HTTP ${account.status}`)
		const { user } = (await account.json()) as { user: { id: string } }
		return ok({ userId: user.id })
	} catch (e) {
		return err(String(e))
	}
}

async function main() {
	const result = await runSeed({
		kind: env.BMP_SERVER_KIND,
		webBaseUrl: env.WEB_BASE_URL,
		createTestPlayer,
		upsertWebAdmin: upsertAdminPlayer,
		signAdminToken: (admin) =>
			signJwt({ playerId: admin.id, steamName: admin.steamName }),
	})
	await pool.end()
	if (!result.ok) {
		const { error } = result
		console.error(
			error.kind === 'official_server'
				? '[seed] Refusing to seed the Official server (BMP_SERVER_KIND=official).'
				: `[seed] Could not make ${error.username}: ${error.reason}`,
		)
		process.exit(1)
	}
	console.log('[seed] Test players (Dev mod: BMP_IMPERSONATE_NAME=<name>):')
	for (const p of result.value.players)
		console.log(`  ${p.username}  device id ${p.deviceId}  user ${p.userId}`)
	console.log(
		`[seed] Web admin login (valid ${env.JWT_EXPIRES_IN}; run seed again for a new one):`,
	)
	console.log(`  ${result.value.adminLoginUrl}`)
	process.exit(0)
}

main().catch((e) => {
	console.error('[seed] Failed:', e)
	process.exit(1)
})
