// Lobby chat RPCs. Sending goes through an RPC, not a match op, because the
// moderation service is an HTTP call and the match loop must never wait on one:
// the match is asked to check the sender (chat_check), the message is moderated
// here, then the match is told to post it (chat_post).
import {
	INVALID_ARGUMENT,
	PERMISSION_DENIED,
	UNAVAILABLE,
	runtimeError,
} from '../errors'
import { readConfig, type ServerConfig } from '../config'
import { chatBanRefusal } from '../moderation/access'
import { readBans } from '../moderation/bans'
import { currentLobby } from '../lobby/rpc'
import { playerView, profileFor, updateProfile, type Profile } from '../player/profile'
import { parsePayload, requireUser } from '../rpc'
import type { LobbySignal } from '../lobby/protocol'
import {
	MAX_MESSAGE_LENGTH,
	callModeration,
	decideModerationOutcome,
} from './moderation'

function tosAccepted(profile: Profile, config: ServerConfig): boolean {
	return profile.tosAcceptedVersion >= config.tosVersion
}

// {} -> {enabled, player}: turns chat on for the caller (the API's
// /auth/chat/enable). Refused for a chat-blocked account (the age check at
// ToS time) and before the current ToS is accepted.
export function rpcChatEnable(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const config = readConfig(nk)
	const profile = updateProfile(
		nk,
		userId,
		(current) => {
			if (current.chatBlocked) throw runtimeError(PERMISSION_DENIED, 'Chat access is permanently restricted')
			if (!tosAccepted(current, config)) throw runtimeError(PERMISSION_DENIED, 'Accept the Terms of Service first')
			return { ...current, chatEnabled: true }
		},
		ctx.username,
	)
	return JSON.stringify({ enabled: true, player: playerView(userId, profile) })
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
	const config = readConfig(nk)
	if (!config.chatEnabled) throw runtimeError(UNAVAILABLE, 'Chat is turned off')
	const profile = profileFor(nk, userId, ctx.username)
	if (profile.chatBlocked || !profile.chatEnabled)
		throw runtimeError(PERMISSION_DENIED, 'Chat is not enabled for this account')
	if (!tosAccepted(profile, config)) throw runtimeError(PERMISSION_DENIED, 'Accept the Terms of Service first')
	const banned = chatBanRefusal(readBans(nk, userId), Date.now())
	if (banned) throw runtimeError(PERMISSION_DENIED, banned)

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
