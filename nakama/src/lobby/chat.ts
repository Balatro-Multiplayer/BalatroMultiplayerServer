// Lobby chat rules as pure functions over the lobby (see state.ts): who may
// talk, how fast, and what the moderation service is shown as context. The
// moderation call itself happens in the chat_send RPC, not the match loop.
import { type Lobby, type Step, findPlayer } from './state'
import { ServerOp } from './protocol'

// Token bucket per sender, kept in the lobby's action budget under its own key.
export const CHAT_BURST = 5
export const CHAT_REFILL_MS = 1000
// How many earlier lines the moderation service sees.
export const CHAT_CONTEXT_LINES = 8
export const CHAT_TAIL = 20

export interface ChatLine {
	senderId: string
	text: string
}

export type ChatCheck =
	| { ok: true; lobby: Lobby; displayName: string; context: { who: 'sender' | 'other'; text: string }[] }
	| { ok: false; reason: 'not_in_lobby' | 'rate_limited' }

export function chatBudgetKey(userId: string): string {
	return 'chat:' + userId
}

export function chatCheck(lobby: Lobby, userId: string, now: number): ChatCheck {
	const player = findPlayer(lobby, userId)
	if (!player || lobby.closed) return { ok: false, reason: 'not_in_lobby' }
	const key = chatBudgetKey(userId)
	const bucket = lobby.actionBudget[key] || { tokens: CHAT_BURST, at: now }
	const tokens = Math.min(CHAT_BURST, bucket.tokens + (now - bucket.at) / CHAT_REFILL_MS)
	if (tokens < 1) return { ok: false, reason: 'rate_limited' }
	const next = {
		...lobby,
		actionBudget: { ...lobby.actionBudget, [key]: { tokens: tokens - 1, at: now } },
	}
	const context = (lobby.chat || []).slice(-CHAT_CONTEXT_LINES).map((line) => ({
		who: (line.senderId === userId ? 'sender' : 'other') as 'sender' | 'other',
		text: line.text,
	}))
	return { ok: true, lobby: next, displayName: player.info.displayName, context }
}

// Delivers an approved line to everyone seated (the sender too: the client
// shows chat from the same stream for every player) and keeps it as context.
export function chatPost(lobby: Lobby, userId: string, text: string): Step {
	const player = findPlayer(lobby, userId)
	if (!player || lobby.closed) return { lobby, out: [] }
	const chat = (lobby.chat || []).concat([{ senderId: userId, text }]).slice(-CHAT_TAIL)
	return {
		lobby: { ...lobby, chat },
		out: [
			{
				kind: 'send',
				op: ServerOp.CHAT,
				payload: { senderId: userId, displayName: player.info.displayName, message: text },
				to: lobby.players.map((p) => p.id),
			},
		],
	}
}
