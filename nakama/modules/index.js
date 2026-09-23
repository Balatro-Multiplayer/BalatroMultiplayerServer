// Nakama JavaScript runtime module (docker-compose.local.yml's `nakama`
// service loads it from /nakama/data/modules).
//
// Steam login. Nakama's built-in authenticate_steam can't be used: it only
// calls Valve's partner endpoint, which needs Balatro's publisher key. Instead
// the client calls authenticate_custom with its Steam ticket in
// vars.steam_ticket; the before-hook below checks the ticket on the public
// api.steampowered.com endpoint (the same check the API's /api/auth/steam
// does, with the same STEAM_WEB_API_KEY) and signs the player in under the
// custom id "steam:<steamid>". The BMP API trusts exactly that custom id
// (apps/server/src/features/auth/nakama.ts), so every other way of setting a
// custom id is refused.

var STEAM_AUTH_URL = 'https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/'
var STEAM_CUSTOM_ID_PREFIX = 'steam:'
var STEAM_TICKET_PATTERN = /^[0-9a-fA-F]{16,4096}$/
var STEAM_TIMEOUT_MS = 10000

// Nakama's gRPC status codes, as the client sees them. Hook functions must
// be top-level named functions: Nakama registers them by name.
var INVALID_ARGUMENT = 3
var PERMISSION_DENIED = 7
var UNAUTHENTICATED = 16
var UNAVAILABLE = 14

function runtimeError(code, message) {
	return { code: code, message: message }
}

// Returns the Steam ID the ticket belongs to, or throws a runtime error. The
// URL carries the key, so it is never logged.
function verifySteamTicket(ctx, logger, nk, ticket) {
	var key = ctx.env['STEAM_WEB_API_KEY']
	var appId = ctx.env['STEAM_APP_ID'] || '2379780'
	if (!key) {
		logger.error('Steam login is not configured: STEAM_WEB_API_KEY is empty')
		throw runtimeError(UNAVAILABLE, 'Steam login is not configured')
	}

	var url = STEAM_AUTH_URL + '?key=' + encodeURIComponent(key) + '&appid=' + encodeURIComponent(appId) + '&ticket=' + ticket
	var response
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

	var params = null
	try {
		var data = JSON.parse(response.body)
		params = data && data.response && data.response.params
	} catch (e) {
		params = null
	}
	if (!params || params.result !== 'OK' || !params.steamid) {
		throw runtimeError(UNAUTHENTICATED, 'Invalid Steam ticket')
	}
	return String(params.steamid)
}

function beforeAuthenticateCustom(ctx, logger, nk, data) {
	var account = data.account || {}
	var vars = account.vars || {}
	var ticket = vars['steam_ticket']
	if (!ticket || !STEAM_TICKET_PATTERN.test(ticket)) {
		throw runtimeError(INVALID_ARGUMENT, 'Custom login needs a Steam ticket in vars.steam_ticket')
	}

	var steamId = verifySteamTicket(ctx, logger, nk, ticket)
	account.id = STEAM_CUSTOM_ID_PREFIX + steamId
	// vars end up inside the session token; the ticket has no business there.
	delete vars['steam_ticket']
	account.vars = vars
	data.account = account
	return data
}

function refuseCustomIdChange(ctx, logger, nk, data) {
	throw runtimeError(PERMISSION_DENIED, 'Custom ids are only set by Steam login')
}

function InitModule(ctx, logger, nk, initializer) {
	initializer.registerBeforeAuthenticateCustom(beforeAuthenticateCustom)
	initializer.registerBeforeLinkCustom(refuseCustomIdChange)
	initializer.registerBeforeUnlinkCustom(refuseCustomIdChange)
	logger.info('BMP Steam login module loaded')
}
