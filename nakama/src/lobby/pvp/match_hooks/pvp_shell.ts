// The thin shell between the lobby and the PvP core. Everything here that decides is a
// pure function of plain data (the clock comes in as `now`); `pvpHooks` only reads the
// lobby, calls them, and writes `lobby.game.pvp` back.
import type { ServerConfig } from '../../../config'
import { lobbyKindOf } from '../../../review/ranked'
import { belowMinimum } from '../../../standing/pvp_version'
import type { Ending, Refusal } from '../../hooks'
import {
	type LobbyEventMessage,
	type Placement,
	ServerOp,
} from '../../protocol'
import { type Lobby, type Outbound, type Step, awayEndsAt } from '../../state'
import { apply } from '../core/apply'
import {
	endPlayerPause,
	catchUpClocks,
	shiftTimes,
	startPlayerPause,
	resumeAfterReady,
} from '../core/clock'
import { isWholeNumber } from '../core/request_checks'
import { same } from '../core/same'
import { settleMatch, tick } from '../core/tick'
import type {
	AwayFrom,
	AwayReason,
	Milliseconds,
	MyView,
	PlayerId,
	PlayerPause,
	Run,
	State,
} from '../core/types'
import { type ViewFacts, view } from '../core/view'
import { dropPlayer, endGameHandler, leaveBeforeRun } from '../inputs/finish'
import { openPvpBlindIfReady } from '../inputs/pvp_blind'
import { isAway } from '../rules/pvp_blind_rules'
import { modeOfQueue } from '../rules/settings'
import { type LastViewSent, viewsToSend } from './last_view_sent'
import { rulesOf, setupDoneFor, startPvpRun } from './pvp_start'

// The sent-view record is the lobby hooks' type; the lobby reads it from here.
export type { LastViewSent }

// ---- Facts from the lobby ----

export interface ShellFacts extends ViewFacts {
	ranked: boolean
	// Players whose seat the lobby took at the end of their grace; a subset of `left`.
	forfeited: PlayerId[]
	// When and why each away player became away.
	awayFrom: { [player: PlayerId]: AwayFrom }
}

function awayFromOf(lobby: Lobby): ShellFacts['awayFrom'] {
	const from: ShellFacts['awayFrom'] = {}
	for (const player of lobby.players)
		if (player.awaySince !== null && player.awayReason !== null)
			from[player.id] = { since: player.awaySince, reason: player.awayReason }
	return from
}

export function factsOf(lobby: Lobby): ShellFacts {
	const matchPlayers = Object.keys(lobby.game.pvp?.players ?? {})
	const runId = lobby.game.started?.runId
	const away = lobby.players.flatMap((player) =>
		player.awaySince === null
			? []
			: [
					{
						id: player.id,
						endsAt: awayEndsAt(lobby, player, player.awaySince),
					},
				],
	)
	const left = matchPlayers.filter(
		(id) => !lobby.players.some((player) => player.id === id),
	)
	const soonest = Math.min(...away.map((entry) => entry.endsAt))
	return {
		gameStarted: lobby.game.started !== null,
		away: away.map((entry) => entry.id),
		left,
		// One display deadline: the earliest grace; those ending with it are named.
		grace:
			away.length === 0
				? null
				: {
						against: away.filter((e) => e.endsAt === soonest).map((e) => e.id),
						endsAt: soonest,
					},
		messageNumbers: lobby.messageNumbers ?? {},
		ranked: lobbyKindOf(lobby) === 'ranked',
		awayFrom: awayFromOf(lobby),
		forfeited: left.filter(
			(id) => runId !== undefined && lobby.forfeitedSeats?.[id] === runId,
		),
	}
}

// This player's view of the game that ended; null when none ended since the last start.
export function endedView(
	lobby: Lobby,
	player: PlayerId,
	now: Milliseconds,
): MyView | null {
	const ended = lobby.game.ended
	if (ended === undefined) return null
	return view(
		ended,
		player,
		now,
		factsOf({ ...lobby, game: { ...lobby.game, pvp: ended } }),
	)
}

export interface InputFacts {
	ranked: boolean
	// The players who have left, and when and why each away player became away, as in `ShellFacts`.
	left: PlayerId[]
	awayFrom: ShellFacts['awayFrom']
	// The session each seated player is on now.
	sessions: { [player: PlayerId]: string }
	// The newest input number taken from each player.
	messageNumbers: ViewFacts['messageNumbers']
}

export function inputFactsOf(lobby: Lobby): InputFacts {
	const { ranked, left, awayFrom, messageNumbers } = factsOf(lobby)
	const sessions: InputFacts['sessions'] = {}
	for (const player of lobby.players) sessions[player.id] = player.sessionId
	return { ranked, left, awayFrom, sessions, messageNumbers }
}

// ---- Inputs and ticks ----

export interface InputResult {
	state: State
	// The refusal codes, for the log; a stale session has none.
	refusals: string[]
	// The newest input number taken from the sender afterwards.
	lastNumber: number
}

const pauseReasonOf = (
	reason: AwayReason,
): Exclude<PlayerPause['reason'], 'animating'> =>
	reason === 'dropped' ? 'away' : 'server restart'

// A player who comes back leaves their away pause at `now`, the return moment, and starts in
// their shop: their Ready mark is dropped.
export function endAwayPauses(
	run: Run,
	now: Milliseconds,
	facts: Pick<InputFacts, 'awayFrom' | 'left'>,
): Run {
	let clocks = run.clocks
	const ready = { ...run.ready }
	let firstReady = run.firstReady
	let returned = false
	for (const pause of run.clocks.playerPauses) {
		const player = pause.player
		const away =
			facts.awayFrom[player] !== undefined && !facts.left.includes(player)
		if (away || pause.reason === 'animating') continue
		clocks = resumeAfterReady(
			endPlayerPause(clocks, player, pause.reason, now),
			player,
			now,
		)
		delete ready[player]
		firstReady = firstReady.filter((id) => id !== player)
		returned = true
	}
	return returned ? { ...run, clocks, ready, firstReady } : run
}

// Each player who dropped and is not paused yet is paused at their own drop, never later: the
// timers run to that moment first, then wait. A drop is charged to the away budget, a server
// restart is not.
function startAwayPauses(
	state: State,
	now: Milliseconds,
	facts: Pick<InputFacts, 'ranked' | 'awayFrom' | 'left'>,
): State {
	const drops = Object.entries(facts.awayFrom)
		.filter(([player]) => !facts.left.includes(player))
		.sort(([, a], [, b]) => a.since - b.since)
	let current = state
	for (const [player, from] of drops) {
		const before = current.run
		if (before === null || current.result !== null) break
		if (before.clocks.players[player] === undefined || isAway(before, player))
			continue
		const at = Math.min(Math.max(from.since, before.clocks.settledAt), now)
		const ticked = tick(current, at, facts)
		const run = ticked.run
		if (run === null || ticked.result !== null) return ticked
		current = {
			...ticked,
			run: {
				...run,
				clocks: startPlayerPause(
					run.clocks,
					player,
					pauseReasonOf(from.reason),
					run.rules.limits,
					at,
				),
			},
		}
	}
	return current
}

// The clocks as they stand at `now`, stored when settling moved a countdown (an animating
// budget that ran out starts its countdowns again), so the view never shows a pause that is
// over. A budget only being charged is not stored: that would make every tick a change.
export function settledRun(run: Run, now: Milliseconds): Run {
	const clocks = catchUpClocks(run.clocks, now)
	return same(clocks.countdowns, run.clocks.countdowns)
		? run
		: { ...run, clocks }
}

// The pauses of players who came back, ended at `now`.
function returnedAway(
	state: State,
	now: Milliseconds,
	facts: Pick<InputFacts, 'awayFrom' | 'left'>,
): State {
	const before = state.run
	if (before === null || state.result !== null) return state
	const run = endAwayPauses(before, now, facts)
	return run === before ? state : { ...state, run }
}

// The match brought up to `now`: the drops are paused at their own moment, the returns end
// their pause, then the timers run. `handleMessage` and `shellTick` both go through it, so the
// result is the same whichever comes first.
function bringUpToNow(
	state: State,
	now: Milliseconds,
	facts: Pick<InputFacts, 'ranked' | 'awayFrom' | 'left'>,
): State {
	const paused = startAwayPauses(state, now, facts)
	const ticked = tick(returnedAway(paused, now, facts), now, facts)
	const before = ticked.run
	if (before === null) return ticked
	const run = settledRun(before, now)
	// A player who came back may have been the one the PvP blind waited for.
	return openPvpBlindIfReady(run === before ? ticked : { ...ticked, run }, now)
}

// One message from a player's session. A message from any session but the current one is
// dropped. The timers run before the message, so a hand that arrives after its timer ended
// loses to the timer.
export function handleMessage(
	state: State,
	player: PlayerId,
	session: string,
	message: unknown,
	now: Milliseconds,
	facts: InputFacts,
): InputResult {
	const last = facts.messageNumbers[player] ?? 0
	if (facts.sessions[player] !== session)
		return { state, refusals: [], lastNumber: last }
	const applied = apply(
		bringUpToNow(state, now, facts),
		player,
		message,
		last,
		now,
	)
	return { ...applied, state: settleMatch(applied.state, facts) }
}

// What the core leaves to the shell: the away pauses, and every player the lobby no longer
// has. The core's own timers run in `tick`; a player gone past the grace forfeits (a rated
// loss in a ranked lobby), any other gone player has left. All the gone are dropped before
// the match is decided once, so both gone is `abandoned`, one gone is a win.
export function shellTick(
	state: State,
	now: Milliseconds,
	facts: ShellFacts,
): State {
	if (state.result !== null) return state
	const gone = Object.keys(state.players).filter((id) =>
		facts.left.includes(id),
	)
	if (state.run === null) return leaveBeforeRun(state, gone, facts.ranked)
	const ticked = bringUpToNow(state, now, facts)
	const dropped = gone.reduce(
		(current, id) =>
			dropPlayer(
				current,
				id,
				facts.forfeited.includes(id) ? 'forfeit' : 'left',
				now,
			),
		ticked,
	)
	if (dropped === ticked) return ticked
	return settleMatch(openPvpBlindIfReady(dropped, now), facts)
}

// After a restart of the server: the downtime is nobody's time.
export function resumeState(state: State, downtime: Milliseconds): State {
	return shiftTimes(state, downtime)
}

// ---- The ending ----

// null until the match has a result. A win or a draw is stored `agreed` with the places the
// core decided; every other ending has none.
export function ending(state: State): Ending | null {
	const result = state.result
	if (result === null) return null
	if (result.kind !== 'win' && result.kind !== 'draw')
		return { status: result.kind, placements: [] }
	const places = state.run?.places ?? {}
	const placements: Placement[] = Object.keys(places)
		.map((playerId) => ({ playerId, place: places[playerId] }))
		.sort((a, b) => a.place - b.place || a.playerId.localeCompare(b.playerId))
	return { status: 'agreed', placements }
}

// ---- Joining ----

// What a session sees when the same account joins from another one: it is then kicked, and
// its game does not rejoin by itself.
export const CONNECTION_REPLACED_REASON = 'opened_elsewhere'

export function connectionReplacedNotice(
	lobby: Lobby,
	playerId: PlayerId,
): LobbyEventMessage {
	return {
		type: 'player_kicked',
		lobbyCode: lobby.code,
		playerId,
		displayName: lobby.players.find((player) => player.id === playerId)?.info
			.displayName,
		data: { kickedBy: 'server', reason: CONNECTION_REPLACED_REASON },
	}
}

// The newest item the joining player says it did. Both keys absent is "none"; a number for
// another run is "none" too; one key alone, a bad type, or a number past the inbox is refused.
function lastItemOf(
	run: Run,
	player: PlayerId,
	keys: { [key: string]: unknown },
): number | Refusal {
	const hasItem = 'pvp_inbox_done' in keys
	const hasRun = 'pvp_run' in keys
	if (!hasItem && !hasRun) return 0
	const item = keys.pvp_inbox_done
	const runId = keys.pvp_run
	if (!hasItem || !hasRun || !isWholeNumber(item) || typeof runId !== 'string')
		return { reject: 'bad_params' }
	if (runId !== run.id) return 0
	return item > (run.players[player]?.inbox.length ?? 0)
		? { reject: 'bad_params' }
		: item
}

// A join message carries its keys as text; the last-item number is read as a whole number.
function wholeNumberKeys(keys: { [key: string]: string }): {
	[key: string]: unknown
} {
	const item = keys.pvp_inbox_done
	return typeof item === 'string' && /^\d{1,9}$/.test(item)
		? { ...keys, pvp_inbox_done: Number(item) }
		: keys
}

export function joinState(
	state: State,
	player: PlayerId,
	keys: { [key: string]: unknown },
): State | Refusal {
	const run = state.run
	const mine = run?.players[player]
	if (run === null || mine === undefined) return state
	const item = lastItemOf(run, player, keys)
	if (typeof item !== 'number') return item
	return {
		...state,
		run: {
			...run,
			players: { ...run.players, [player]: { ...mine, inboxDone: item } },
		},
	}
}

// ---- The hooks ----

// A pick made before the run starts (Draft, Setup) is copied into the lobby's `teamPicks`, the one
// owner of a pick; once the run has started its teams are the run's, not picks.
const storePvp = (lobby: Lobby, pvp: State): Lobby => {
	const teamPicks = { ...lobby.teamPicks }
	for (const [id, player] of Object.entries(pvp.players))
		if (pvp.run === null && player.team !== null) teamPicks[id] = player.team
	return { ...lobby, teamPicks, game: { ...lobby.game, pvp } }
}

// The match as it stands, with the run started when Setup is over; the clock has already
// ticked once, so a player gone or away at the start is handled at once. A player who has
// left is seen first, before any run is built: a leave in the Draft or Setup ends a match
// that never began, abandoned and unrated when ranked (leaveBeforeRun).
function startedStep(
	lobby: Lobby,
	config: ServerConfig,
	now: number,
): Step | Refusal {
	const before = lobby.game.pvp
	if (before !== undefined) {
		const left = shellTick(before, now, factsOf(lobby))
		if (left.result !== null) return { lobby: storePvp(lobby, left), out: [] }
	}
	const queue = rulesOf(lobby)
	if (!queue.ok || !setupDoneFor(lobby, queue.rules.queue_mode))
		return queue.ok ? { lobby, out: [] } : { reject: queue.reject }
	const run = startPvpRun(lobby, config, now)
	if (!run.ok) return { reject: run.reject }
	const next = storePvp(lobby, run.state)
	return {
		lobby: storePvp(next, shellTick(run.state, now, factsOf(next))),
		out: [],
	}
}

function newMatch(
	lobby: Lobby,
	config: ServerConfig,
	now: number,
): Step | Refusal {
	const started = lobby.game.started
	const merged = rulesOf(lobby)
	if (started === null) return { reject: 'no_game' }
	if (!merged.ok) return { reject: merged.reject }
	const mode = modeOfQueue(merged.rules.queue_mode)
	if (mode === null) return { reject: 'bad_rules' }
	const players: State['players'] = {}
	for (const player of started.players)
		players[player.id] = { team: lobby.teamPicks?.[player.id] ?? null }
	const fresh = storePvp(lobby, {
		lobbyMode: mode,
		players,
		run: null,
		result: null,
	})
	return startedStep(fresh, config, now)
}

// With no live match, a player's input belongs to the game that ended: only `endGame` changes
// it. The lobby's message numbers are the newest.
function inputAfterGameEnded(
	lobby: Lobby,
	from: { playerId: PlayerId; session: string },
	message: unknown,
	now: Milliseconds,
): { lobby: Lobby; refusals: string[] } {
	const ended = lobby.game.ended
	if (ended === undefined || lobby.players.every((p) => p.id !== from.playerId))
		return { lobby, refusals: [] }
	if (inputFactsOf(lobby).sessions[from.playerId] !== from.session)
		return { lobby, refusals: [] }
	const last = lobby.messageNumbers?.[from.playerId] ?? 0
	const taken = apply(ended, from.playerId, message, last, now, {
		endGame: endGameHandler,
	})
	const run = ended.run
	const next: State = {
		...ended,
		...(run !== null && taken.state.run !== null
			? { run: { ...run, endGames: taken.state.run.endGames } }
			: {}),
	}
	return {
		lobby: {
			...lobby,
			messageNumbers: {
				...lobby.messageNumbers,
				[from.playerId]: taken.lastNumber,
			},
			game: { ...lobby.game, ended: next },
		},
		refusals: taken.refusals,
	}
}

// The only action keys one player's message may still carry to another player: the mod
// framework's synced-card bus under PvP's prefix, which shows each player's jokers on the other's board.
export const PVP_RELAYED_KEYS: readonly string[] = ['mp_mpapi_sync']

export const pvpHooks = {
	// A game has been built for the lobby: refuse it, or add PvP's own state.
	onStart(lobby: Lobby, config: ServerConfig, now: number): Step | Refusal {
		for (const player of lobby.game.started?.players ?? []) {
			const version = lobby.players.find((seat) => seat.id === player.id)?.info
				.pvpVersion
			if (belowMinimum(version, config.pvpMinVersion))
				return { reject: 'pvp_update_required' }
		}
		return newMatch(lobby, config, now)
	},
	// A Setup action, or the Setup tick, has changed the lobby's Setup results; a refusal means
	// the run cannot be built from what Setup produced.
	startRunWhenSetupDone(
		lobby: Lobby,
		config: ServerConfig,
		now: number,
	): Step | Refusal {
		const pvp = lobby.game.pvp
		if (pvp === undefined || pvp.run !== null || pvp.result !== null)
			return { lobby, out: [] }
		return startedStep(lobby, config, now)
	},
	// A restart has built the new game; the Setup results were kept.
	onRestart(lobby: Lobby, config: ServerConfig, now: number): Step | Refusal {
		return newMatch(lobby, config, now)
	},
	// A player is joining; joinKeys are the keys of its join message.
	onJoin(
		lobby: Lobby,
		join: { playerId: string; joinKeys: { [key: string]: string } },
		now: number,
	): Step | Refusal {
		const pvp = lobby.game.pvp
		if (pvp === undefined || pvp.players[join.playerId] === undefined)
			return { lobby, out: [] }
		// The return moment ends their away pause.
		const joined = joinState(
			returnedAway(pvp, now, inputFactsOf(lobby)),
			join.playerId,
			wholeNumberKeys(join.joinKeys),
		)
		if ('reject' in joined) return joined
		// The joiner's view goes out with `views`, which the lobby asks for after a join; the
		// lobby forgets what it last sent this player, so a new session is sent a whole view.
		return { lobby: storePvp(lobby, joined), out: [] }
	},
	// The lobby was loaded from its checkpoint after the server was down for downtime.
	onResume(lobby: Lobby, downtime: number): Lobby {
		const pvp = lobby.game.pvp
		return pvp === undefined
			? lobby
			: storePvp(lobby, resumeState(pvp, downtime))
	},
	ending(lobby: Lobby, _now: number): Ending | null {
		const pvp = lobby.game.pvp
		return pvp === undefined ? null : ending(pvp)
	},
	// One message of op 8 from a player's session; the refusal codes are for the log.
	onInput(
		lobby: Lobby,
		from: { playerId: string; session: string },
		message: unknown,
		now: number,
	): { lobby: Lobby; refusals: string[] } {
		const pvp = lobby.game.pvp
		if (pvp === undefined) return inputAfterGameEnded(lobby, from, message, now)
		const taken = handleMessage(
			pvp,
			from.playerId,
			from.session,
			message,
			now,
			inputFactsOf(lobby),
		)
		// An input that only takes its number leaves game.pvp the same object, so the new number
		// goes out with the same loop's tick views.
		return {
			lobby: {
				...storePvp(lobby, taken.state),
				messageNumbers: {
					...lobby.messageNumbers,
					[from.playerId]: taken.lastNumber,
				},
			},
			refusals: taken.refusals,
		}
	},
	// The 5 Hz tick: the match clock, and every player the lobby no longer has.
	onTick(lobby: Lobby, now: number): Lobby {
		const pvp = lobby.game.pvp
		if (pvp === undefined) return lobby
		const next = shellTick(pvp, now, factsOf(lobby))
		return next === pvp ? lobby : storePvp(lobby, next)
	},
	// The views that changed since `sent`, as sends, and the new record of what was sent.
	views(
		lobby: Lobby,
		sent: LastViewSent,
		now: number,
	): { out: Outbound[]; sent: LastViewSent } {
		const pvp = lobby.game.pvp
		if (pvp === undefined) return { out: [], sent }
		const shown = viewsToSend(
			sent,
			pvp,
			lobby.players.map((player) => player.id),
			now,
			factsOf(lobby),
		)
		return {
			out: shown.views.map(({ player, view }) => ({
				kind: 'send',
				op: ServerOp.VIEW,
				payload: view,
				to: [player],
			})),
			sent: shown.sent,
		}
	},
}
