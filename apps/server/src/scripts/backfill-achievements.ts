// Runs the achievement backfill (features/achievements/achievements-backfill.service.ts)
// again from a shell: it fills any player still unfilled and changes nothing
// for a player already filled. The API runs it at boot, and the webadmin
// route POST /api/webadmin/achievements/backfill does the same as this.
// Run: `node dist/scripts/backfill-achievements.js`.
import { backfillAchievements } from '../features/achievements/achievements-backfill.service.js'

async function main() {
	const result = await backfillAchievements({ force: true })
	if (!result.ok) {
		console.error(`[achievements] Backfill not run: ${result.error}`)
		process.exit(1)
	}
	const { filled, skipped, failed } = result.value
	console.log(
		`[achievements] Backfill: ${filled} filled, ${skipped} already filled, ${failed} failed`,
	)
	process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
	console.error('[achievements] Backfill failed:', err)
	process.exit(1)
})
