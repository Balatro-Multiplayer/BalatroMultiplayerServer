import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import type { Result } from '../../shared/utils/result.js'
import { RUN_LOG_TTL_MS } from './mirror.service.js'

// Nakama keeps a finished run's record and replay logs for as long as
// match_run_logs keeps them here (RUN_LOG_TTL_MS): every hour, ask it to
// delete the older ones. It keeps flagged and disputed runs itself. Hourly
// rather than daily so a sweep missed while Nakama is still booting (or
// restarting) is retried soon; a sweep with nothing to delete is one call.

export const RUN_RETENTION_DAYS = RUN_LOG_TTL_MS / (24 * 60 * 60 * 1000)
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000
// Calls per sweep at most, each deleting up to Nakama's own cap.
const MAX_CALLS = 50

type Rpc = <T>(id: string, body: Record<string, unknown>) => Promise<Result<T, NakamaRpcError>>

// One sweep: calls until Nakama has nothing more to delete. Returns how many
// runs went.
export async function purgeNakamaRuns(rpc: Rpc): Promise<number> {
	let total = 0
	for (let call = 0; call < MAX_CALLS; call++) {
		const result = await rpc<{ deleted: number; more: boolean }>('admin_runs_purge', {
			olderThanDays: RUN_RETENTION_DAYS,
		})
		if (!result.ok) {
			if (result.error !== 'disabled') console.warn(`[retention] purge failed: ${result.error}`)
			return total
		}
		total += result.value.deleted
		if (!result.value.more) return total
	}
	return total
}

export function startRetentionJob(): () => void {
	const sweep = () =>
		void purgeNakamaRuns(callNakamaRpc)
			.then((deleted) => {
				if (deleted > 0) console.log(`[retention] purged ${deleted} Nakama runs`)
			})
			.catch((err) => console.error('[retention] purge failed:', err))
	sweep()
	const timer = setInterval(sweep, RETENTION_INTERVAL_MS)
	timer.unref()
	return () => clearInterval(timer)
}
