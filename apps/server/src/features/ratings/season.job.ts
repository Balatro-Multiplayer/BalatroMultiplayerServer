import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import { checkSeasonRollover } from '../../infrastructure/gateways/rating.gateway.js'

// Rolls an expired season over to the next one. Reloading the config pushes
// the new season to Nakama, which rates games into it from then on.

export const SEASON_CHECK_INTERVAL_MS = 60 * 60 * 1000

export async function rollSeasons(): Promise<number> {
	const rolled = await checkSeasonRollover()
	if (rolled > 0) await loadConfigFromDb()
	return rolled
}

export function startSeasonJob(): () => void {
	const check = () =>
		void rollSeasons().catch((err) =>
			console.error('[ratings] season rollover failed:', err),
		)
	check()
	const timer = setInterval(check, SEASON_CHECK_INTERVAL_MS)
	timer.unref()
	return () => clearInterval(timer)
}
