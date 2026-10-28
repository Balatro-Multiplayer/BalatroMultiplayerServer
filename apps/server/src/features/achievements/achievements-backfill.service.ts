import {
	type NakamaRpcError,
	callNakamaRpc,
} from '../../infrastructure/nakama/admin-client.js'
import { pushConfigToNakama } from '../../infrastructure/nakama/config-sync.js'
import { type Result, err, ok } from '../../shared/utils/result.js'
import { getConfig } from '../../state/config.js'

// Achievement progress lives in Nakama storage, and the games it is counted
// from are there too, so Nakama does the filling (admin_achievements_backfill,
// nakama/src/achievements/backfill.ts) with the same rules as a new game. The
// API only drives its pages: once at boot, and again from webadmin.

// One page's answer.
export interface BackfillPage {
	// achievementsEnabled is on (nothing is filled while it is off).
	enabled: boolean
	done: boolean
	filled: number
	// Players filled before.
	skipped: number
	failed: number
	cursor: string
}

export interface BackfillSummary {
	filled: number
	skipped: number
	failed: number
}

// off: Nakama has achievements switched off.
export type BackfillError = NakamaRpcError | 'off'

export type BackfillCall = (
	body: Record<string, unknown>,
) => Promise<Result<BackfillPage, NakamaRpcError>>

// A page reads every game of up to 20 players: more than the default timeout.
const PAGE_TIMEOUT_MS = 60_000

const callNakama: BackfillCall = (body) =>
	callNakamaRpc<BackfillPage>('admin_achievements_backfill', body, {
		timeoutMs: PAGE_TIMEOUT_MS,
	})

// Runs the backfill to the end. Nakama answers at once when it is already
// done; force fills any player still unfilled anyway (a player is never
// filled twice).
export async function backfillAchievements(
	options: { force?: boolean },
	call: BackfillCall = callNakama,
): Promise<Result<BackfillSummary, BackfillError>> {
	const summary: BackfillSummary = { filled: 0, skipped: 0, failed: 0 }
	let cursor = ''
	do {
		const result = await call({ cursor, force: options.force === true })
		if (!result.ok) return result
		const page = result.value
		if (!page.enabled) return err('off')
		summary.filled += page.filled
		summary.skipped += page.skipped
		summary.failed += page.failed
		cursor = page.cursor
	} while (cursor !== '')
	return ok(summary)
}

// Nakama may boot after the API, and may still hold the switch from before
// this boot's config push.
const BOOT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000]

export interface BootDeps {
	pushConfig: () => Promise<boolean>
	call: BackfillCall
	sleep: (ms: number) => Promise<void>
}

const bootDeps: BootDeps = {
	pushConfig: () => pushConfigToNakama(getConfig()),
	call: callNakama,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
}

// Run at API boot: pushes the config (so Nakama has the switch this
// database holds), then fills. Never throws.
export async function fillAchievementsAtBoot(
	deps: BootDeps = bootDeps,
): Promise<void> {
	try {
		await deps.pushConfig()
		for (let attempt = 0; ; attempt++) {
			const result = await backfillAchievements({}, deps.call)
			if (result.ok) {
				const { filled, skipped, failed } = result.value
				console.log(
					`[achievements] Backfill: ${filled} filled, ${skipped} already filled, ${failed} failed`,
				)
				return
			}
			const waitable = result.error === 'off' || result.error === 'unreachable'
			if (!waitable || attempt >= BOOT_RETRY_DELAYS_MS.length) {
				console.warn(`[achievements] Backfill not run: ${result.error}`)
				return
			}
			await deps.sleep(BOOT_RETRY_DELAYS_MS[attempt])
		}
	} catch (e) {
		console.warn('[achievements] Backfill failed:', e)
	}
}
