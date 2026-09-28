// Steam login. Nakama's built-in authenticate_steam can't be used: it only
// calls Valve's partner endpoint, which needs Balatro's publisher key. Instead
// the client calls authenticate_custom with its Steam ticket in
// vars.steam_ticket; the before-hook below checks the ticket on the public
// api.steampowered.com endpoint (the same check the API's /api/auth/steam
// does, with the same STEAM_WEB_API_KEY) and signs the player in under the
// custom id "steam:<steamid>". The BMP API trusts exactly that custom id
// (apps/server/src/features/auth/nakama.ts), so every other way of setting a
// custom id is refused.
//
// Device login is for local multi-instance testing only (impersonated
// ClaudeControl instances have no Steam ticket): refused unless the runtime
// env sets ALLOW_DEVICE_AUTH=true, which only docker-compose.local.yml does.
import {
	INVALID_ARGUMENT,
	PERMISSION_DENIED,
	UNAUTHENTICATED,
	UNAVAILABLE,
	runtimeError,
} from './errors'

const STEAM_AUTH_URL =
	'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/'
const STEAM_CUSTOM_ID_PREFIX = 'steam:'
const STEAM_TICKET_PATTERN = /^[0-9a-fA-F]{16,4096}$/
const STEAM_TIMEOUT_MS = 10000

// Returns the Steam ID the ticket belongs to, or throws a runtime error. The
// URL carries the key, so it is never logged.
function verifySteamTicket(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	ticket: string,
) {
	const key = ctx.env.STEAM_WEB_API_KEY
	const appId = ctx.env.STEAM_APP_ID || '2379780'
	if (!key) {
		logger.error('Steam login is not configured: STEAM_WEB_API_KEY is empty')
		throw runtimeError(UNAVAILABLE, 'Steam login is not configured')
	}

	const url = `${STEAM_AUTH_URL}?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}&ticket=${ticket}`
	let response: nkruntime.HttpResponse
	try {
		response = nk.httpRequest(url, 'get', {}, '', STEAM_TIMEOUT_MS)
	} catch (e) {
		logger.warn('Steam ticket check failed: request error')
		throw runtimeError(UNAVAILABLE, 'Steam request failed')
	}
	if (response.code !== 200) {
		logger.warn('Steam ticket check failed: HTTP %d', response.code)
		throw runtimeError(UNAVAILABLE, 'Steam request failed')
	}

	let result: {
		params?: { result?: string; steamid?: string }
		error?: { errorcode?: number; errordesc?: string }
	} | null
	try {
		const data = JSON.parse(response.body)
		result = data?.response
	} catch (e) {
		result = null
	}
	const params = result?.params
	if (!params || params.result !== 'OK' || !params.steamid) {
		const steamError = result?.error || {}
		logger.warn(
			'Steam rejected the ticket: %v %v',
			steamError.errorcode,
			steamError.errordesc,
		)
		throw runtimeError(UNAUTHENTICATED, 'Invalid Steam ticket')
	}
	return String(params.steamid)
}

export function beforeAuthenticateCustom(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	data: nkruntime.AuthenticateCustomRequest,
) {
	const account = data.account || {}
	const vars = account.vars || {}
	const ticket = vars.steam_ticket
	if (!ticket || !STEAM_TICKET_PATTERN.test(ticket)) {
		throw runtimeError(
			INVALID_ARGUMENT,
			'Custom login needs a Steam ticket in vars.steam_ticket',
		)
	}

	const steamId = verifySteamTicket(ctx, logger, nk, ticket)
	account.id = STEAM_CUSTOM_ID_PREFIX + steamId
	// vars end up inside the session token; the ticket has no business there.
	// biome-ignore lint/performance/noDelete: the key must be gone, not undefined -- vars becomes a Go map[string]string
	delete vars.steam_ticket
	account.vars = vars
	data.account = account
	return data
}

export function refuseCustomIdChange(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	data: nkruntime.AccountCustom,
): nkruntime.AccountCustom {
	throw runtimeError(
		PERMISSION_DENIED,
		'Custom ids are only set by Steam login',
	)
}

export function beforeAuthenticateDevice(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	data: nkruntime.AuthenticateDeviceRequest,
) {
	if (ctx.env.ALLOW_DEVICE_AUTH !== 'true') {
		throw runtimeError(PERMISSION_DENIED, 'Device login is disabled')
	}
	return data
}
