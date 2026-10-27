import { env } from '../../env.js'
import { err, ok } from '../../shared/utils/result.js'
import type { Result } from '../../shared/utils/result.js'

// disabled: NAKAMA_METRICS_URL is not set.
export type NakamaMetricsError = 'disabled' | 'unreachable' | 'rejected'

const TIMEOUT_MS = 3000

// The text body of Nakama's Prometheus endpoint (metrics.prometheus_port in
// nakama/prod.yml and local.yml), reached over the compose network only.
export async function fetchNakamaMetrics(): Promise<
	Result<string, NakamaMetricsError>
> {
	if (env.NAKAMA_METRICS_URL === '') return err('disabled')
	let response: Response
	try {
		response = await fetch(env.NAKAMA_METRICS_URL, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
	} catch {
		return err('unreachable')
	}
	if (!response.ok) return err('rejected')
	try {
		return ok(await response.text())
	} catch {
		return err('unreachable')
	}
}
