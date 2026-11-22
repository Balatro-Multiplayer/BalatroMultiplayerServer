// Who may send a relayed action. Most relayed actions are a player's claim
// about itself and anyone may send them; the ones below decide the match, so
// the relay (relay.ts) drops them from anyone else and never forwards them.
//
// The host of record is the lobby's own `hostId`, which moves with a host
// transfer (state.ts transferHostFrom). Pure.
import type { Lobby } from './state'

// 'host': only the host of record sends it (the SPDRN host's timeout/draw/reseed).
// 'self': `params.player_id` names the sender.
// 'self_or_host': the player claims it for itself, or the host declares it for
//   another (a SPDRN forfeit win: the host's check_single_survivor names the
//   one player left).
export type SenderRule = 'host' | 'self' | 'self_or_host'

export const SENDER_RULES = {
	// SPDRN host decisions.
	spdrn_match_timeout: 'host', // matchmaking/duration.lua: host clock
	spdrn_match_draw: 'host', // ui/lobby/draw_vote.lua: host on unanimity
	spdrn_seed_change_apply: 'host', // ui/lobby/seed_vote.lua: host on unanimity
	// SPDRN results keyed on a param id.
	spdrn_player_won: 'self_or_host',
	spdrn_player_result: 'self', // matchmaking/result.lua: player_id = own id
} as const satisfies { [key: string]: SenderRule }

export type RuledKey = keyof typeof SENDER_RULES

export type SenderRefusal =
	| { kind: 'not_host'; key: RuledKey; from: string; hostId: string }
	| {
			kind: 'not_self'
			key: RuledKey
			from: string
			hostId: string
			// What the payload claimed instead; null when it named nobody.
			claimed: string | null
	  }

export function senderRuleOf(key: string): SenderRule | null {
	return Object.prototype.hasOwnProperty.call(SENDER_RULES, key)
		? SENDER_RULES[key as RuledKey]
		: null
}

function claimedPlayer(params: unknown): string | null {
	if (typeof params !== 'object' || params === null || Array.isArray(params))
		return null
	const id = (params as { [key: string]: unknown }).player_id
	return typeof id === 'string' ? id : null
}

// Why `from` may not send `key` with `params`, or null when it may.
export function senderRefusal(
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown,
): SenderRefusal | null {
	const rule = senderRuleOf(key)
	if (rule === null) return null
	const ruled = key as RuledKey
	const hostId = lobby.hostId
	const isHost = from === hostId
	if (rule === 'host')
		return isHost ? null : { kind: 'not_host', key: ruled, from, hostId }
	if (rule === 'self_or_host' && isHost) return null
	const claimed = claimedPlayer(params)
	return claimed === from
		? null
		: { kind: 'not_self', key: ruled, from, hostId, claimed }
}
