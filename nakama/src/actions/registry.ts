// Authoritative actions: the MPAPI ActionTypes declared `authoritative = true`
// (MPAPI api/action/builtin.lua), which the server runs instead of relaying.
// Every other action -- anything mod-specific -- is relayed untouched
// (lobby/relay.ts), so the server never needs to know a mod's actions.
//
// Pure: a reducer gets the lobby and its context and returns the new game
// state plus the results to broadcast, or a rejection reason for the sender.
import type { GameState, StartedGame } from '../lobby/protocol'
import {
	type Lobby,
	type Outbound,
	MAX_PLAYERS,
	emptyGame,
} from '../lobby/state'
import { finishGame, parsePlacements } from './results'

export interface ActionContext {
	from: string
	now: number
	// A fresh Balatro seed and a fresh run id (injected so reducers stay
	// deterministic in tests).
	newSeed: () => string
	newId: () => string
}

// A result broadcast as ACTION {from:'server'}: to every player (the
// default), every player but the sender, or nobody. `out` are further effects
// (storing a finished run), carried out after the broadcast.
export interface ActionResult {
	game: GameState
	params: unknown
	to?: 'all' | 'others' | 'none'
	out?: Outbound[]
}

export type Reduction = ActionResult | { reject: string }

export interface AuthoritativeAction {
	key: string
	reduce(lobby: Lobby, ctx: ActionContext, params: unknown): Reduction
}

const MAX_OPTIONS_BYTES = 4 * 1024
const MIN_GAME_PLAYERS = 2

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// {ready: boolean} -- the sender's own ready flag.
const ready: AuthoritativeAction = {
	key: 'mpapi_ready',
	reduce(lobby, ctx, params) {
		if (!isPlainObject(params) || typeof params.ready !== 'boolean')
			return { reject: 'bad_params' }
		if (lobby.game.started) return { reject: 'in_game' }
		const readyMap = { ...lobby.game.ready }
		if (params.ready) readyMap[ctx.from] = true
		else delete readyMap[ctx.from]
		return {
			game: { ...lobby.game, ready: readyMap },
			params: { playerId: ctx.from, ready: params.ready },
		}
	},
}

// What every client gets when a game starts (or restarts).
function startedParams(started: StartedGame) {
	return {
		runId: started.runId,
		seed: started.seed,
		stake: started.stake,
		options: started.options,
		players: started.players,
	}
}

// A new game on the lobby's present players, with a server-picked seed.
function newGame(
	lobby: Lobby,
	ctx: ActionContext,
	stake: number | null,
	options: unknown,
): StartedGame {
	return {
		runId: ctx.newId(),
		seed: ctx.newSeed(),
		stake,
		options,
		startedAt: ctx.now,
		hostId: lobby.hostId,
		players: lobby.players
			.filter((pl) => pl.awaySince === null)
			.map((pl) => ({
				id: pl.id,
				displayName: pl.info.displayName,
				...(pl.info.preferredJoker ? { avatar: pl.info.preferredJoker } : {}),
			})),
	}
}

// {stake?, options?, minPlayers?} -- host only, once every other connected
// player is ready. The server picks the seed, so the host can't. minPlayers
// lets a gamemode ask for more than the usual two.
const startGame: AuthoritativeAction = {
	key: 'mpapi_start_game',
	reduce(lobby, ctx, params) {
		const p = isPlainObject(params) ? params : {}
		if (p.stake !== undefined && typeof p.stake !== 'number')
			return { reject: 'bad_params' }
		if (
			p.minPlayers !== undefined &&
			(typeof p.minPlayers !== 'number' || p.minPlayers % 1 !== 0)
		)
			return { reject: 'bad_params' }
		const options = p.options === undefined ? null : p.options
		if (JSON.stringify(options).length > MAX_OPTIONS_BYTES)
			return { reject: 'bad_params' }
		if (lobby.hostId !== ctx.from) return { reject: 'not_host' }
		if (lobby.game.started) return { reject: 'in_game' }
		// Queueing as a group (lobby/group_queue.ts): the group's game is the
		// public one it's matched into.
		if (lobby.groupQueue) return { reject: 'group_queue' }
		const minPlayers = Math.min(
			Math.max(MIN_GAME_PLAYERS, typeof p.minPlayers === 'number' ? p.minPlayers : 0),
			lobby.maxPlayers,
			MAX_PLAYERS,
		)
		const present = lobby.players.filter((pl) => pl.awaySince === null)
		if (present.length < minPlayers) return { reject: 'too_few_players' }
		for (const pl of present) {
			if (pl.id !== lobby.hostId && !lobby.game.ready[pl.id])
				return { reject: 'not_all_ready' }
		}
		const started = newGame(
			lobby,
			ctx,
			typeof p.stake === 'number' ? p.stake : null,
			options,
		)
		return {
			game: { ...emptyGame(), started },
			params: startedParams(started),
		}
	},
}

// The lobby metadata key a mod writes the drafted stake to. Mirrored by hand
// in PvP (`PVP.LOBBY_METADATA.DRAFTED_STAKE`); change both together.
export const DRAFTED_STAKE_KEY = 'drafted_stake'

// The stake the host drafted after the game started (a mod writes it to the
// lobby metadata under DRAFTED_STAKE_KEY, a whole number or its decimal
// string). Null when absent, cleared (the empty string a mod writes when a new
// game starts, so an old draft cannot leak into it) or not a whole number
// from 1 up.
function draftedStake(lobby: Lobby): number | null {
	const raw = lobby.metadata[DRAFTED_STAKE_KEY]
	const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null
}

// {} -- host only: a new game on a new seed, same options. The stake is the
// drafted one when the host wrote it to the metadata, else the game's own. The
// current one is stored as 'restarted' (no GAME_ENDED: clients go straight
// into the new game, through the same path as a start).
const restartGame: AuthoritativeAction = {
	key: 'mpapi_restart_game',
	reduce(lobby, ctx) {
		if (lobby.hostId !== ctx.from) return { reject: 'not_host' }
		const current = lobby.game.started
		if (!current) return { reject: 'not_in_game' }
		const finished = finishGame(lobby, ctx.now, {
			status: 'restarted',
			announce: false,
		})
		const started = newGame(
			finished.lobby,
			ctx,
			draftedStake(lobby) ?? current.stake,
			current.options,
		)
		return {
			game: { ...emptyGame(), started },
			params: startedParams(started),
			out: finished.out,
		}
	},
}

// {} -- host only: ends the game without a result.
const abandonGame: AuthoritativeAction = {
	key: 'mpapi_abandon_game',
	reduce(lobby, ctx) {
		if (lobby.hostId !== ctx.from) return { reject: 'not_host' }
		const current = lobby.game.started
		if (!current) return { reject: 'not_in_game' }
		const finished = finishGame(lobby, ctx.now, {
			status: 'abandoned',
			announce: true,
		})
		return {
			game: finished.lobby.game,
			params: { runId: current.runId },
			out: finished.out,
		}
	},
}

function isParticipant(lobby: Lobby, userId: string): boolean {
	const started = lobby.game.started
	return !!started && started.players.some((p) => p.id === userId)
}

// {placements: [{playerId, place, performance?, metric?}]} -- every
// participant's own view of the result. A later report replaces an earlier
// one; results.ts settles the game once they're all in.
const reportResult: AuthoritativeAction = {
	key: 'mpapi_report_result',
	reduce(lobby, ctx, params) {
		const started = lobby.game.started
		if (!started) return { reject: 'not_in_game' }
		if (!isParticipant(lobby, ctx.from)) return { reject: 'not_participant' }
		const placements = parsePlacements(
			isPlainObject(params) ? params.placements : null,
			started.players,
		)
		if (!placements) return { reject: 'bad_params' }
		const game = lobby.game
		return {
			game: {
				...game,
				reports: { ...game.reports, [ctx.from]: placements },
				reportOrder:
					game.reportOrder.indexOf(ctx.from) === -1
						? game.reportOrder.concat([ctx.from])
						: game.reportOrder,
				settleFrom: game.settleFrom === null ? ctx.now : game.settleFrom,
			},
			params: { playerId: ctx.from, reported: true },
		}
	},
}

// A player's replay log is capped; past it, further events are dropped (not
// refused, so the client isn't warned on every event).
export const MAX_LOG_EVENTS = 20_000
export const MAX_LOG_BYTES = 1024 * 1024
const MAX_OPCODE_LENGTH = 64

// {t, opcode, args?, run?} -- one replay event from a participant, kept for the
// stored run and passed on to the others (who track how far each player's
// stream has got).
const logEvent: AuthoritativeAction = {
	key: 'mpapi_log_event',
	reduce(lobby, ctx, params) {
		if (!lobby.game.started) return { reject: 'not_in_game' }
		if (!isParticipant(lobby, ctx.from)) return { reject: 'not_participant' }
		if (
			!isPlainObject(params) ||
			typeof params.t !== 'number' ||
			typeof params.opcode !== 'string' ||
			params.opcode.length === 0 ||
			params.opcode.length > MAX_OPCODE_LENGTH
		)
			return { reject: 'bad_params' }
		// An event the client sent for a run the server has since restarted
		// (it was in flight as the restart went out) belongs to no stored
		// log: kept, it would sit ahead of the new run's manifest and fail
		// the new run's hash check. Clients tag events with their run.
		if (typeof params.run === 'string' && params.run !== lobby.game.started.runId)
			return { game: lobby.game, params: null, to: 'none' }
		const args = params.args === undefined ? null : params.args
		const line = JSON.stringify([params.t, params.opcode, args])
		const size = line.length

		const game = lobby.game
		const log = game.logs[ctx.from] || { lines: [], bytes: 0, truncated: false }
		if (
			log.truncated ||
			log.lines.length >= MAX_LOG_EVENTS ||
			log.bytes + size > MAX_LOG_BYTES
		) {
			const truncated = { ...log, truncated: true }
			return {
				game: { ...game, logs: { ...game.logs, [ctx.from]: truncated } },
				params: null,
				to: 'none',
			}
		}
		const grown = {
			lines: log.lines.concat([line]),
			bytes: log.bytes + size,
			truncated: false,
		}
		return {
			game: { ...game, logs: { ...game.logs, [ctx.from]: grown } },
			params: { playerId: ctx.from, t: params.t, opcode: params.opcode, args },
			to: 'others',
		}
	},
}

const REGISTRY: { [key: string]: AuthoritativeAction } = {
	[ready.key]: ready,
	[startGame.key]: startGame,
	[restartGame.key]: restartGame,
	[abandonGame.key]: abandonGame,
	[reportResult.key]: reportResult,
	[logEvent.key]: logEvent,
}

// The replay-log action, which relay.ts budgets separately.
export const LOG_EVENT_KEY = logEvent.key

export function authoritativeAction(key: string): AuthoritativeAction | null {
	return Object.prototype.hasOwnProperty.call(REGISTRY, key)
		? REGISTRY[key]
		: null
}

// Balatro's seed alphabet: 1-9 and A-Z without O (G.CONTROLLER seed entry).
const SEED_ALPHABET = '123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
export const SEED_LENGTH = 8

// Turns random hex (e.g. a UUID) into a Balatro seed.
export function seedFromHex(hex: string): string {
	const digits = hex.replace(/[^0-9a-f]/gi, '')
	let seed = ''
	for (let i = 0; i < SEED_LENGTH; i++) {
		const n = Number.parseInt(digits.substr(i * 3, 3) || '0', 16)
		seed += SEED_ALPHABET[n % SEED_ALPHABET.length]
	}
	return seed
}
