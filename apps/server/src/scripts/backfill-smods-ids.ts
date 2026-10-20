// One-off: reads the SMODS ids of every ranked pin made before migration 0051
// (features/mods/smods-ids-backfill.service.ts), then pushes the new
// matchmaking allowlist -- that field alone; the API's next config load
// sends the rest -- to Nakama. The webadmin's "Read SMODS ids" button
// (POST /api/webadmin/mods/smods-ids/backfill) does the same from a running
// API. Run after migrating: `node dist/scripts/backfill-smods-ids.js`.
import { backfillSmodsIds } from '../features/mods/smods-ids-backfill.service.js'
import { pool } from '../infrastructure/db/index.js'
import { pinnedSmodsIds } from '../infrastructure/gateways/config.gateway.js'
import { callNakamaRpc, isNakamaAdminEnabled } from '../infrastructure/nakama/admin-client.js'

async function main() {
	const summary = await backfillSmodsIds()
	const queueAllowedModIds = await pinnedSmodsIds()
	console.log(`[smods-ids] Allowlist now ${queueAllowedModIds.length} id(s): ${queueAllowedModIds.join(', ') || '(none)'}`)
	if (isNakamaAdminEnabled()) {
		const pushed = await callNakamaRpc('admin_config_set', { queueAllowedModIds })
		console.log(pushed.ok ? '[smods-ids] Pushed to Nakama' : `[smods-ids] NOT pushed to Nakama: ${pushed.error}`)
	} else {
		console.log('[smods-ids] Nakama not configured; the API pushes it on its next config load')
	}
	await pool.end()
	process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err) => {
	console.error('[smods-ids] Backfill failed:', err)
	process.exit(1)
})
