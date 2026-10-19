// Replay logs for tests, modelled on real stored logs (match_logs on the
// local stack): the framing events each mod writes and the MPAPI generic
// opcodes' arg shapes (api/replay/generic_codes.lua).
import type { PlayerLog } from '../lobby/protocol'
import { eventsOf, type LogEvent } from '../shared/replay/events'

export type Tuple = [number, string, unknown]

export function logOf(tuples: Tuple[]): PlayerLog {
	const lines = tuples.map((tuple) => JSON.stringify(tuple))
	return { lines, bytes: lines.reduce((n, l) => n + l.length, 0), truncated: false }
}

export const eventsFrom = (tuples: Tuple[]): LogEvent[] => eventsOf(logOf(tuples))

// A PvP game's opening, as MultiplayerPvP 0.5.1 logs it.
export function pvpOpening(deck = 'Red Deck', ruleset = 'ruleset_mp_balanced'): Tuple[] {
	return [
		[0, 'match_manifest', { mod_id: 'MultiplayerPvP', lobby_code: '5YEVDY', lobby_type: 'private', schema_version: 1, start_epoch_ms: 1792424179000 }],
		[
			1,
			'lobby_info',
			{
				decks: [deck],
				options: { sleeve: 'sleeve_casl_none', challenge: '', mod_version: '0.5.1', the_order_enabled: true },
				players: [{ is_host: true }, { id: '398ac6c4-a0f3-4ca4-acd0-91b32a1f9b66', is_host: false }],
				ruleset,
				gamemode: 'gamemode_mp_attrition',
			},
		],
		[2, 'run_info', { deck, seed: 'M2HUVPRS', stake: 1 }],
	]
}

// A Speedrun game's opening, as MultiplayerSPDRN logs it.
export function spdrnOpening(gamemode = 'spdrn_gold_stake_single', deck: unknown = 'b_ghost'): Tuple[] {
	return [
		[0, 'match_manifest', { mod_id: 'MultiplayerSPDRN', lobby_code: 'ZNGVBR', lobby_type: 'private', schema_version: 1, start_epoch_ms: 1792424104000 }],
		[1, 'lobby_info', { decks: [deck], options: { kind: 'private', stake: 1, gamemode }, players: [], ruleset: 'spdrn_order', gamemode }],
		[2506, 'run_info', { deck, seed: 'PUJ1RTVP', stake: 1 }],
	]
}

// A played hand: play [indices, refs] (refs first-seen, playing cards).
export function play(t: number, firstId: number): Tuple {
	return [t, 'play', [[1, 2], [[-firstId, 'pc', 'Hearts', 'King'], [-(firstId + 1), 'pc', 'Spades', '10', 'e:m_glass']]]]
}

export const closing = (t: number, result: 'win' | 'loss'): Tuple[] => [
	[t, 'end', { result }],
	[t + 1, 'chk', { carbon: 'x'.repeat(64), human: 'y', bytes: 100 }],
]
