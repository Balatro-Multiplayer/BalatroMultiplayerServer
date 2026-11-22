// The lobby stage of a lobby the server referees: Ready and Start come up as numbered inputs (op 8), the
// same envelope the PvP match uses, and the lobby's own view goes down. The number counts in
// `lobby.messageNumbers`, which the match carries on, so one sequence runs from the lobby into
// the game. An input is taken once, in order; a resend or a gap is ignored; the state it asks
// for is the sender's latest. Start's refusal is kept in the view (`startAnswers`), not lost.
import { SERVER_TARGET, ServerOp } from './protocol'
import type { PvpViewMessage } from './protocol'
import { type RelayStep, action } from './relay'
import type { ActionContext } from '../actions/registry'
import { apply } from './pvp/core/apply'
import { isMessageNumber, judgeMessageNumber } from './pvp/core/request_checks'
import type { State } from './pvp/core/types'
import { teamHandler } from './pvp/inputs/entry'
import { modeOfQueue } from './pvp/rules/settings'
import { endedView } from './pvp/match_hooks/pvp_shell'
import { rulesOf } from './pvp/match_hooks/pvp_start'
import { type Lobby, setMetadata } from './state'

export const LOBBY_INPUT_KINDS = ['lobbyReady', 'lobbyStart', 'team'] as const

export function isLobbyInput(data: { [key: string]: unknown }): boolean {
	return LOBBY_INPUT_KINDS.some((kind) => kind === data.kind)
}

// The authoritative action an input stands for; its reducer does the deciding.
function actionOf(data: { [key: string]: unknown }): {
	key: string
	params: unknown
} {
	if (data.kind === 'lobbyReady')
		return { key: 'mpapi_ready', params: { ready: data.ready } }
	return {
		key: 'mpapi_start_game',
		params: { stake: data.stake, options: data.options },
	}
}

// A team pick made in the lobby, before the game starts: the same part and checks the match runs,
// on the match as it would be built now. The pick waits in `teamPicks` for newMatch.
function takeTeamInput(
	lobby: Lobby,
	senderId: string,
	data: { [key: string]: unknown },
	now: number,
): RelayStep {
	const merged = rulesOf(lobby)
	const mode = merged.ok ? modeOfQueue(merged.rules.queue_mode) : null
	if (mode === null) {
		// The refused input still takes its number, or the resend and every later input stall; a number
		// already taken is a resend, as in apply: nothing changes and nothing is refused.
		const number = data.messageNumber
		const verdict = judgeMessageNumber(
			lobby.messageNumbers?.[senderId] ?? 0,
			number,
		)
		if (verdict === 'unreadable' || !isMessageNumber(number))
			return {
				lobby,
				out: [],
				refused: { key: 'input', reason: 'unreadable_header' },
			}
		if (verdict === 'ignored') return { lobby, out: [] }
		return {
			lobby: {
				...lobby,
				messageNumbers: { ...lobby.messageNumbers, [senderId]: number },
			},
			out: [],
			refused: { key: 'input', reason: 'bad_rules' },
		}
	}
	const players: State['players'] = {}
	for (const seat of lobby.players)
		players[seat.id] = { team: lobby.teamPicks?.[seat.id] ?? null }
	const taken = apply(
		{ lobbyMode: mode, players, run: null, result: null },
		senderId,
		data,
		lobby.messageNumbers?.[senderId] ?? 0,
		now,
		{ team: teamHandler },
	)
	const mine = taken.state.players[senderId]
	const refused =
		taken.refusals.length > 0
			? { refused: { key: 'input', reason: taken.refusals.join(',') } }
			: {}
	if (mine === undefined) return { lobby, out: [], ...refused }
	return {
		lobby: {
			...lobby,
			messageNumbers: { ...lobby.messageNumbers, [senderId]: taken.lastNumber },
			teamPicks: {
				...lobby.teamPicks,
				...(mine.team === null ? {} : { [senderId]: mine.team }),
			},
		},
		out: [],
		...refused,
	}
}

export function takeLobbyInput(
	lobby: Lobby,
	senderId: string,
	data: { [key: string]: unknown },
	ctx: Omit<ActionContext, 'from'>,
): RelayStep {
	const number = data.messageNumber
	if (!lobby.players.some((player) => player.id === senderId))
		return { lobby, out: [] }
	if (data.kind === 'team') return takeTeamInput(lobby, senderId, data, ctx.now)
	const verdict = judgeMessageNumber(
		lobby.messageNumbers?.[senderId] ?? 0,
		number,
	)
	if (verdict === 'unreadable' || !isMessageNumber(number))
		return {
			lobby,
			out: [],
			refused: { key: 'input', reason: 'unreadable_header' },
		}
	if (verdict === 'ignored') return { lobby, out: [] }
	// The number is taken before the action runs, so a game started by it carries it on.
	const counted: Lobby = {
		...lobby,
		messageNumbers: { ...lobby.messageNumbers, [senderId]: number },
	}
	const asked = actionOf(data)
	const step = action(
		counted,
		senderId,
		{ cid: '', action: asked.key, to: SERVER_TARGET, params: asked.params },
		ctx,
	)
	// A busy sender is told to wait: the input stays untaken and the resend comes again.
	if (step.refused?.reason === 'rate_limited') return { lobby, out: [] }
	// The answer is in the view, not an ACTION_REJECTED nobody waits for.
	const out = step.out.filter(
		(sent) => !(sent.kind === 'send' && sent.op === ServerOp.ACTION_REJECTED),
	)
	if (data.kind !== 'lobbyStart') return { ...step, out }
	return {
		...step,
		out,
		lobby: {
			...step.lobby,
			startAnswers: {
				...step.lobby.startAnswers,
				[senderId]: { number, refused: step.refused?.reason ?? null },
			},
		},
	}
}

// The host's lobby settings (deck, stake, ruleset, Cocktail recipe) come up as a numbered input
// in the lobby and in the game alike, on the sender's one number: the match keeps it once begun.
export function isSettingsInput(data: { [key: string]: unknown }): boolean {
	return data.kind === 'lobbySettings'
}

export function takeSettingsInput(
	lobby: Lobby,
	senderId: string,
	data: { [key: string]: unknown },
): RelayStep {
	const number = data.messageNumber
	if (!lobby.players.some((player) => player.id === senderId))
		return { lobby, out: [] }
	const verdict = judgeMessageNumber(
		lobby.messageNumbers?.[senderId] ?? 0,
		number,
	)
	if (verdict === 'unreadable' || !isMessageNumber(number))
		return {
			lobby,
			out: [],
			refused: { key: 'input', reason: 'unreadable_header' },
		}
	// A seat that is not in the match takes no settings input.
	const pvp = lobby.game.pvp
	if (
		verdict === 'ignored' ||
		(pvp !== undefined && pvp.players[senderId] === undefined)
	)
		return { lobby, out: [] }
	const counted: Lobby = {
		...lobby,
		messageNumbers: { ...lobby.messageNumbers, [senderId]: number },
	}
	const step = setMetadata(counted, senderId, data.settings)
	// A patch the server won't take (not the host's, not a table) is still a taken input: it changes nothing.
	return {
		lobby: step.lobby,
		out: step.out.filter(
			(sent) => !(sent.kind === 'send' && sent.op === ServerOp.ERROR),
		),
	}
}

const readyOf = (lobby: Lobby, id: string): 'ready' | 'not ready' =>
	lobby.game.ready[id] === true ? 'ready' : 'not ready'

// The lobby stage's view of one player, in the shape of the match's view with no run.
export function lobbyView(
	lobby: Lobby,
	player: string,
	now: number,
): PvpViewMessage {
	const number = lobby.messageNumbers?.[player] ?? 0
	const answer = lobby.startAnswers?.[player]
	const ended = endedView(lobby, player, now)
	return {
		serverTime: now,
		lastMessageReceived: number,
		me: player,
		match: {
			stage: 'lobby',
			result: null,
			run: null,
			lobby: {
				// The game reads a flag per seat.
				ready: Object.fromEntries(
					lobby.players.map((seat) => [
						seat.id,
						readyOf(lobby, seat.id) === 'ready',
					]),
				),
				away: lobby.players
					.filter((seat) => seat.awaySince !== null)
					.map((seat) => seat.id),
				// Only the answer to the latest input counts: an older one is history.
				start: answer !== undefined && answer.number === number ? answer : null,
			},
			...(ended === null ? {} : { ended }),
		},
		// Only a player who has picked a team is listed, as the match's view shows it.
		players: Object.fromEntries(
			lobby.players.flatMap((seat) => {
				const team = lobby.teamPicks?.[seat.id]
				const status =
					seat.awaySince === null ? ('playing' as const) : ('away' as const)
				return team === undefined ? [] : [[seat.id, { team, status }]]
			}),
		),
		timers: {
			timerButton: 'none',
			deadlines: [],
			pauses: [],
			pvpBanks: {},
			anteBanks: {},
		},
		onlyMine: { traps: [], inbox: [], inboxNewest: 0 },
	}
}
