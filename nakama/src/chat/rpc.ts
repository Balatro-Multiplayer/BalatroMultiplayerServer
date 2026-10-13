// Lobby chat RPCs. Sending goes through an RPC, not a match op, because the
// moderation service is an HTTP call and the match loop must never wait on one:
// the match is asked to check the sender (chat_check), the message is moderated
// here, then the match is told to post it (chat_post).
import {
	INVALID_ARGUMENT,
	PERMISSION_DENIED,
	UNAUTHENTICATED,
	UNAVAILABLE,
	runtimeError,
} from '../errors'
import { currentLobby } from '../lobby/rpc'
import { parsePayload, requireUser } from '../rpc'
import type { LobbySignal } from '../lobby/protocol'
import {
	MAX_MESSAGE_LENGTH,
	callModeration,
	decideModerationOutcome,
} from './moderation'

const PREFS_COLLECTION = 'chat_prefs'
const PREFS_KEY = 'chat'

function isEnabled(nk: nkruntime.Nakama, userId: string): boolean {
	const objects = nk.storageRead([
		{ collection: PREFS_COLLECTION, key: PREFS_KEY, userId },
	])
	return objects.length > 0 && objects[0].value.enabled === true
}

// {} -> turns chat on for the caller (the ToS step of the API's /auth/chat/enable).
export function rpcChatEnable(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	nk.storageWrite([
		{
			collection: PREFS_COLLECTION,
			key: PREFS_KEY,
			userId,
			value: { enabled: true },
			permissionRead: 1,
			permissionWrite: 0,
		},
	])
	return JSON.stringify({ enabled: true })
}

// {message} -> {} once it has been posted to the caller's lobby, or an error:
// PERMISSION_DENIED for a message the moderation service blocked (or chat not
// enabled), UNAVAILABLE when it cannot be judged (fails closed).
export function rpcChatSend(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const message = parsePayload(payload).message
	if (typeof message !== 'string' || !message.trim())
		throw runtimeError(INVALID_ARGUMENT, 'Message is empty')
	if (message.length > MAX_MESSAGE_LENGTH)
		throw runtimeError(INVALID_ARGUMENT, `Message is over ${MAX_MESSAGE_LENGTH} characters`)
	if (!isEnabled(nk, userId)) throw runtimeError(PERMISSION_DENIED, 'Chat is not enabled for this account')

	const current = currentLobby(nk, userId)
	if (!current) throw runtimeError(INVALID_ARGUMENT, 'Not in a lobby')

	const check = JSON.parse(
		nk.matchSignal(current.matchId, JSON.stringify({ type: 'chat_check', userId } as LobbySignal)),
	)
	if (check.error === 'rate_limited') throw runtimeError(UNAVAILABLE, 'You are sending messages too fast')
	if (check.error) throw runtimeError(INVALID_ARGUMENT, 'Not in a lobby')

	const outcome = decideModerationOutcome(
		callModeration(nk, logger, ctx.env, {
			playerId: userId,
			lobbyCode: check.code,
			message,
			context: check.context,
		}),
	)
	if (!outcome.allowed) {
		if (outcome.reason === 'moderated') throw runtimeError(PERMISSION_DENIED, 'Message blocked by moderation')
		throw runtimeError(UNAVAILABLE, 'Chat is unavailable right now')
	}
	const text = outcome.publishText === null ? message : outcome.publishText

	nk.matchSignal(
		current.matchId,
		JSON.stringify({ type: 'chat_post', userId, text } as LobbySignal),
	)
	return JSON.stringify({ text })
}
