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
// Device login (no Steam proof) depends on the server kind (server_kind.ts):
// never on the Official server, always on a Community server, and on a Dev
// server unless ALLOW_DEVICE_AUTH=false. On a Community server the normal
// client logs in with its raw SteamID64 as the device id, so the same Steam
// id is always the same account; its Steam name reaches the profile and the
// display name through session_init, as with Steam login.
import {
	INVALID_ARGUMENT,
	PERMISSION_DENIED,
	UNAUTHENTICATED,
	UNAVAILABLE,
	runtimeError,
} from './errors'
import { checkLoginBan } from './moderation/enforce'
import { claimLegacyRatingsAtLogin } from './rating/legacy'
import { settingsOf } from './server_kind'

const STEAM_AUTH_URL =
	'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/'
const STEAM_CUSTOM_ID_PREFIX = 'steam:'
const STEAM_TICKET_PATTERN = /^[0-9a-fA-F]{16,4096}$/
const STEAM_TIMEOUT_MS = 10000
const STEAM_ID64_PATTERN = /^7656119\d{10}$/

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
	checkLoginBan(nk, logger, 'custom:' + account.id, Date.now())
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
	if (!settingsOf(ctx).deviceLogin) {
		throw runtimeError(PERMISSION_DENIED, 'Device login is disabled')
	}
	const deviceId = data.account && data.account.id
	if (deviceId) checkLoginBan(nk, logger, 'device:' + deviceId, Date.now())
	// Nakama usernames are unique and Steam names are not: a Steam-id login
	// lets Nakama pick the username, and the Steam name becomes the display
	// name instead.
	// biome-ignore lint/performance/noDelete: the key must be gone, not undefined -- the request becomes a Go struct
	if (deviceId && STEAM_ID64_PATTERN.test(deviceId)) delete data.username
	return data
}

// After every Steam login (Nakama allows one after-hook per message, so all
// login-time work hangs off this one). Never fails the login.
export function afterAuthenticateCustom(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	_session: { created?: boolean },
	_request: nkruntime.AuthenticateCustomRequest,
) {
	claimLegacyRatingsAtLogin(ctx, logger, nk)
}
