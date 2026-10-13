// Admin RPCs: server to server only (the runtime http key, no player
// session), for the BMP API to drive Nakama. Called as
// POST /v2/rpc/<id>?http_key=...&unwrap with a JSON body.
import { INVALID_ARGUMENT, runtimeError } from './errors'
import { mergeConfig, readConfig, writeConfig } from './config'
import { callExpress } from './express'
import { isNotifyCode, notify } from './notify'
import { parsePayload, requireServer } from './rpc'

const USER_ID_PATTERN = /^[0-9a-f-]{36}$/

// {} -> {ok, express}: express is whether Nakama could reach the API's
// internal routes back, so one call checks both directions.
export function rpcAdminPing(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const reply = callExpress(nk, logger, ctx.env, '/ping', {})
	return JSON.stringify({ ok: true, express: reply !== null && reply.status === 200 })
}

// {userId, code, subject?, content?, persistent?} -> {}.
export function rpcAdminNotify(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const input = parsePayload(payload)
	if (typeof input.userId !== 'string' || !USER_ID_PATTERN.test(input.userId))
		throw runtimeError(INVALID_ARGUMENT, 'userId is required')
	if (!isNotifyCode(input.code)) throw runtimeError(INVALID_ARGUMENT, 'Unknown notification code')
	const content =
		typeof input.content === 'object' && input.content !== null && !Array.isArray(input.content)
			? (input.content as { [key: string]: unknown })
			: {}
	notify(
		nk,
		input.userId,
		input.code,
		typeof input.subject === 'string' ? input.subject : '',
		content,
		input.persistent === true,
	)
	return JSON.stringify({})
}

// {<any ServerConfig fields>} -> the whole config after the update.
export function rpcAdminConfigSet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const config = mergeConfig(readConfig(nk), parsePayload(payload))
	writeConfig(nk, config)
	logger.info('Server config updated: %v', JSON.stringify(config))
	return JSON.stringify(config)
}
