// The remote moderation bridge, as in the API's features/chat/moderation.ts and
// infrastructure/gateways/moderation.gateway.ts: a pure decision over the
// service's answer, and the one HTTP call.

export type ModerationAttempt = { status: number; body: unknown } | null

export type ModerationBlockReason = 'moderated' | 'unavailable'

export type ModerationOutcome =
	| { allowed: true; publishText: string | null }
	| { allowed: false; reason: ModerationBlockReason; band?: string }

// The relay's own cap on a message: a rewrite may not exceed it.
export const MAX_MESSAGE_LENGTH = 500

function verdictOf(value: unknown): { [key: string]: unknown } | null {
	if (typeof value !== 'object' || value === null) return null
	const record = value as { [key: string]: unknown }
	return record.verdict === 'allow' || record.verdict === 'reject' ? record : null
}

// Anything but a clean 200 with a known verdict fails closed as 'unavailable':
// never allow on uncertainty, including HTTP 429 (the service shedding load).
export function decideModerationOutcome(attempt: ModerationAttempt): ModerationOutcome {
	const body = attempt && attempt.status === 200 ? verdictOf(attempt.body) : null
	if (!body) return { allowed: false, reason: 'unavailable' }

	if (body.verdict === 'allow') {
		const rewrite = body.publishText
		if (rewrite === undefined) return { allowed: true, publishText: null }
		// A rewrite that is unreadable, blank or too long is blocked, never
		// swapped for the original it was meant to remove.
		if (typeof rewrite !== 'string' || !rewrite.trim())
			return { allowed: false, reason: 'moderated', band: 'unusable_rewrite' }
		if (rewrite.length > MAX_MESSAGE_LENGTH)
			return { allowed: false, reason: 'moderated', band: 'oversized_rewrite' }
		return { allowed: true, publishText: rewrite }
	}

	const band = typeof body.band === 'string' ? body.band : undefined
	// The service's own model being down is not the player's fault.
	if (band === 'guard_unavailable') return { allowed: false, reason: 'unavailable' }
	return { allowed: false, reason: 'moderated', band }
}

export interface ModerationRequest {
	playerId: string
	lobbyCode: string
	message: string
	context: { who: 'sender' | 'other'; text: string }[]
}

const DEFAULT_TIMEOUT_MS = 3000

// The moderation load balancer's service name on the compose network
// (docker-compose.yml's moderation-lb). Fixed rather than configurable: chat is
// always judged by that one internal service, never by an address from env.
export const MODERATION_SERVICE_URL = 'http://moderation-lb:8001'

// One attempt against MODERATION_SERVICE_URL (a redirect is a failure: only that
// origin may decide). null on any transport failure.
export function callModeration(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	env: { [key: string]: string },
	request: ModerationRequest,
): ModerationAttempt {
	const headers: { [key: string]: string } = { 'Content-Type': 'application/json' }
	if (env.MODERATION_BEARER_TOKEN) headers.Authorization = `Bearer ${env.MODERATION_BEARER_TOKEN}`
	const timeout = Number(env.MODERATION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
	try {
		const res = nk.httpRequest(
			`${MODERATION_SERVICE_URL}/moderate`,
			'post',
			headers,
			JSON.stringify(request),
			timeout,
		)
		let body: unknown = null
		try {
			body = JSON.parse(res.body)
		} catch (e) {
			// Left null: not a verdict.
		}
		if (res.code !== 200 && res.code !== 429)
			logger.error('Moderation service returned %d, chat fails closed', res.code)
		return { status: res.code, body }
	} catch (e) {
		logger.error('Moderation request failed, chat fails closed: %v', e)
		return null
	}
}
