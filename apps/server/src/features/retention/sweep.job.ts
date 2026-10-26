import { retentionRepository } from '../../infrastructure/gateways/retention.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { sweepRetention } from './sweep.js'

export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export function startRetentionSweepJob(): () => void {
	const sweep = () =>
		void sweepRetention(
			{
				repo: retentionRepository,
				purgeNamedRuns: (runIds) =>
					callNakamaRpc<{ deleted: number }>('admin_runs_purge_named', {
						runIds,
					}),
			},
			new Date(),
		)
			.then((counts) => {
				if (Object.values(counts).some((n) => n > 0))
					console.log('[retention] swept', counts)
			})
			.catch((err) => console.error('[retention] sweep failed:', err))
	sweep()
	const timer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS)
	timer.unref()
	return () => clearInterval(timer)
}
