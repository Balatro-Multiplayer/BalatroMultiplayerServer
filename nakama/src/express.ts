// Server-to-server calls into the BMP API (Express), which still owns the
// Postgres data: player rows, ban history, reports, the service queue and the
// launcher-integrity challenges. Its /internal/nakama routes only accept the
// shared key. Dormant (always null) unless EXPRESS_INTERNAL_URL is set.
//
// nk.httpRequest blocks the JavaScript VM it runs on, so never call this from
// a match loop; RPCs, hooks and matchJoinAttempt are fine.
const TIMEOUT_MS = 3000

export interface ExpressReply {
	status: number
	body: { [key: string]: unknown }
}

export function callExpress(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	env: { [key: string]: string },
	path: string,
	body: { [key: string]: unknown },
): ExpressReply | null {
	const base = (env.EXPRESS_INTERNAL_URL || '').replace(/\/+$/, '')
	if (!base) return null
	let response: nkruntime.HttpResponse
	try {
		response = nk.httpRequest(
			`${base}/internal/nakama${path}`,
			'post',
			{
				'Content-Type': 'application/json',
				'X-BMP-Internal-Key': env.EXPRESS_INTERNAL_KEY || '',
			},
			JSON.stringify(body),
			TIMEOUT_MS,
		)
	} catch (e) {
		logger.warn('Express call %s failed: %v', path, e)
		return null
	}
	let parsed: { [key: string]: unknown } = {}
	try {
		const data = JSON.parse(response.body || '{}')
		if (typeof data === 'object' && data !== null) parsed = data
	} catch (e) {
		logger.warn('Express call %s returned non-JSON (HTTP %d)', path, response.code)
	}
	return { status: response.code, body: parsed }
}
