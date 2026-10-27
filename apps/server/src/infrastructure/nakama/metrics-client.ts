import type { FetchMetrics } from '../../contracts/IStatsSources.js'
import { env } from '../../env.js'
import { err, ok } from '../../shared/utils/result.js'

const TIMEOUT_MS = 3000

// The text body of Nakama's Prometheus endpoint (metrics.prometheus_port in
// nakama/prod.yml and local.yml), reached over the compose network only.
export const fetchNakamaMetrics: FetchMetrics = async () => {
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
