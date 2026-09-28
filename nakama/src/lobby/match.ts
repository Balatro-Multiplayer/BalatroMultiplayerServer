// The bmp_lobby authoritative match: adapts Nakama's match callbacks to the
// pure rules in state.ts and carries out the Outbound effects they return.
// One match per lobby; the match ends (returns null) once the lobby closes.
import { seedFromHex } from '../actions/registry'
import { releaseCode } from './codes'
import {
	CURRENT_LOBBY_COLLECTION,
	CURRENT_LOBBY_KEY,
	ClientOp,
	type LobbySignal,
	type PlayerInfo,
} from './protocol'
import { action } from './relay'
import {
	DEFAULT_GRACE_MS,
	type Lobby,
	type Outbound,
	type Step,
	close,
	disconnect,
	join,
	joinRejection,
	kick,
	labelOf,
	leave,
	newLobby,
	setMetadata,
	setOwnState,
	tick,
} from './state'

const TICK_RATE = 5
const MAX_MESSAGE_BYTES = 64 * 1024

export interface LobbyMatchState extends nkruntime.MatchState {
	lobby: Lobby
	// userId -> the presence currently attached.
	presences: { [userId: string]: nkruntime.Presence }
	// Player info from matchJoinAttempt's metadata, consumed by matchJoin
	// (which gets no metadata of its own).
	pendingInfo: { [userId: string]: PlayerInfo }
	label: string
}

function graceMsFrom(ctx: nkruntime.Context): number {
	const seconds = Number(ctx.env.LOBBY_GRACE_SECONDS)
	return seconds > 0 ? seconds * 1000 : DEFAULT_GRACE_MS
}

// The per-user record lobby_current reads. Only cleared if it still names
// this match, so a player already in a newer lobby keeps its record.
function writeCurrent(
	nk: nkruntime.Nakama,
	ctx: nkruntime.Context,
	lobby: Lobby,
	userId: string,
) {
	nk.storageWrite([
		{
			collection: CURRENT_LOBBY_COLLECTION,
			key: CURRENT_LOBBY_KEY,
			userId,
			value: { matchId: ctx.matchId, code: lobby.code, modId: lobby.modId },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

function clearCurrent(
	nk: nkruntime.Nakama,
	ctx: nkruntime.Context,
	userId: string,
) {
	const key = {
		collection: CURRENT_LOBBY_COLLECTION,
		key: CURRENT_LOBBY_KEY,
		userId,
	}
	const objects = nk.storageRead([key])
	if (objects.length > 0 && objects[0].value.matchId === ctx.matchId) {
		nk.storageDelete([key])
	}
}

// Carries out a Step's effects and returns the new match state, or null once
// the lobby has closed (which ends the match).
function apply(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	state: LobbyMatchState,
	step: Step,
): LobbyMatchState | null {
	const presences = { ...state.presences }
	for (const effect of step.out) {
		runEffect(ctx, logger, nk, dispatcher, step.lobby, presences, effect)
	}

	const label = labelOf(step.lobby)
	if (label !== state.label && !step.lobby.closed) {
		dispatcher.matchLabelUpdate(label)
	}

	if (step.lobby.closed) {
		releaseCode(nk, step.lobby.code, ctx.matchId)
		logger.info('Lobby %s closed', step.lobby.code)
		return null
	}
	return { lobby: step.lobby, presences, pendingInfo: state.pendingInfo, label }
}

function runEffect(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	lobby: Lobby,
	presences: { [userId: string]: nkruntime.Presence },
	effect: Outbound,
) {
	switch (effect.kind) {
		case 'send': {
			const targets = effect.to
				.map((id) => presences[id])
				.filter((p) => p !== undefined)
			// An empty list would mean "everyone" to broadcastMessage.
			if (targets.length > 0) {
				dispatcher.broadcastMessage(
					effect.op,
					JSON.stringify(effect.payload),
					targets,
					null,
					true,
				)
			}
			return
		}
		case 'kick': {
			const presence = presences[effect.userId]
			delete presences[effect.userId]
			if (presence) dispatcher.matchKick([presence])
			return
		}
		case 'setCurrent':
			writeCurrent(nk, ctx, lobby, effect.userId)
			return
		case 'clearCurrent':
			try {
				clearCurrent(nk, ctx, effect.userId)
			} catch (e) {
				logger.warn(
					'Lobby %s: could not clear current lobby of %s: %v',
					lobby.code,
					effect.userId,
					e,
				)
			}
			return
	}
}

function stringParam(params: { [key: string]: unknown }, key: string): string {
	const value = params[key]
	return typeof value === 'string' ? value : ''
}

export function lobbyMatchInit(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	params: { [key: string]: unknown },
) {
	const lobby = newLobby({
		code: stringParam(params, 'code'),
		modId: stringParam(params, 'modId'),
		maxPlayers: Number(params.maxPlayers),
		creatorId: stringParam(params, 'creatorId'),
		now: Date.now(),
		graceMs: graceMsFrom(ctx),
	})
	const label = labelOf(lobby)
	const state: LobbyMatchState = {
		lobby,
		presences: {},
		pendingInfo: {},
		label,
	}
	logger.info('Lobby %s created for %s', lobby.code, lobby.modId)
	return { state, tickRate: TICK_RATE, label }
}

function parseMods(raw: string | undefined): unknown {
	if (!raw) return null
	try {
		return JSON.parse(raw)
	} catch (e) {
		return null
	}
}

// One lobby at a time: a player whose current-lobby record names another
// live match they are still in must leave that one first.
function otherLobbyOf(
	nk: nkruntime.Nakama,
	ctx: nkruntime.Context,
	userId: string,
): string | null {
	const objects = nk.storageRead([
		{ collection: CURRENT_LOBBY_COLLECTION, key: CURRENT_LOBBY_KEY, userId },
	])
	if (objects.length === 0) return null
	const matchId = objects[0].value.matchId
	if (
		typeof matchId !== 'string' ||
		matchId === ctx.matchId ||
		!nk.matchGet(matchId)
	)
		return null
	const signal: LobbySignal = { type: 'has_player', userId }
	return nk.matchSignal(matchId, JSON.stringify(signal)) === 'yes'
		? String(objects[0].value.code)
		: null
}

export function lobbyMatchJoinAttempt(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	presence: nkruntime.Presence,
	metadata: { [key: string]: string },
) {
	const meta = metadata || {}
	const rejection = joinRejection(
		state.lobby,
		presence.userId,
		meta.modId || '',
	)
	if (rejection) {
		return { state, accept: false, rejectMessage: rejection }
	}
	const otherCode = otherLobbyOf(nk, ctx, presence.userId)
	if (otherCode) {
		return {
			state,
			accept: false,
			rejectMessage: `Already in lobby ${otherCode}`,
		}
	}

	const info: PlayerInfo = {
		displayName: meta.displayName || presence.username,
		preferredJoker: meta.preferredJoker || null,
		mods: parseMods(meta.mods),
	}
	return {
		state: {
			...state,
			pendingInfo: { ...state.pendingInfo, [presence.userId]: info },
		},
		accept: true,
	}
}

export function lobbyMatchJoin(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	presences: nkruntime.Presence[],
) {
	let current: LobbyMatchState | null = state
	for (const presence of presences) {
		if (!current) break
		const pendingInfo = { ...current.pendingInfo }
		const info = pendingInfo[presence.userId] || {
			displayName: presence.username,
			preferredJoker: null,
			mods: null,
		}
		delete pendingInfo[presence.userId]
		const attached = {
			...current,
			pendingInfo,
			presences: { ...current.presences, [presence.userId]: presence },
		}
		current = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			attached,
			join(attached.lobby, presence.userId, presence.sessionId, info),
		)
	}
	return current ? { state: current } : null
}

export function lobbyMatchLeave(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	presences: nkruntime.Presence[],
) {
	let current: LobbyMatchState | null = state
	const now = Date.now()
	for (const presence of presences) {
		if (!current) break
		const attached = current.presences[presence.userId]
		if (attached && attached.sessionId === presence.sessionId) {
			const remaining = { ...current.presences }
			delete remaining[presence.userId]
			current = { ...current, presences: remaining }
		}
		current = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			current,
			disconnect(current.lobby, presence.userId, presence.sessionId, now),
		)
	}
	return current ? { state: current } : null
}

function parseMessage(
	nk: nkruntime.Nakama,
	message: nkruntime.MatchMessage,
): { [key: string]: unknown } | null {
	if (message.data.byteLength > MAX_MESSAGE_BYTES) return null
	try {
		const data = JSON.parse(nk.binaryToString(message.data))
		// Lua JSON encoders can't tell an empty object from an empty array,
		// so a payload-less op from the game arrives as [].
		if (Array.isArray(data)) return data.length === 0 ? {} : null
		return typeof data === 'object' && data !== null ? data : null
	} catch (e) {
		return null
	}
}

function stepForMessage(
	nk: nkruntime.Nakama,
	lobby: Lobby,
	senderId: string,
	opCode: number,
	data: { [key: string]: unknown },
): Step | null {
	switch (opCode) {
		case ClientOp.ACTION:
			return action(lobby, senderId, data, {
				now: Date.now(),
				newSeed: () => seedFromHex(nk.uuidv4()),
			})
		case ClientOp.LEAVE:
			return leave(lobby, senderId)
		case ClientOp.KICK:
			return kick(
				lobby,
				senderId,
				typeof data.playerId === 'string' ? data.playerId : '',
			)
		case ClientOp.SET_METADATA:
			return setMetadata(lobby, senderId, data.metadata)
		case ClientOp.SET_STATE:
			return setOwnState(
				lobby,
				senderId,
				data.state === undefined ? null : data.state,
			)
		default:
			return null
	}
}

export function lobbyMatchLoop(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	messages: nkruntime.MatchMessage[],
) {
	let current: LobbyMatchState | null = state
	for (const message of messages) {
		if (!current) break
		const data = parseMessage(nk, message)
		const step =
			data &&
			stepForMessage(
				nk,
				current.lobby,
				message.sender.userId,
				message.opCode,
				data,
			)
		if (!step) {
			logger.warn(
				'Lobby %s: dropped op %d from %s',
				current.lobby.code,
				message.opCode,
				message.sender.userId,
			)
			continue
		}
		current = apply(ctx, logger, nk, dispatcher, current, step)
	}
	if (!current) return null
	const ticked = apply(
		ctx,
		logger,
		nk,
		dispatcher,
		current,
		tick(current.lobby, Date.now()),
	)
	return ticked ? { state: ticked } : null
}

export function lobbyMatchSignal(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	data: string,
) {
	let signal: LobbySignal
	try {
		signal = JSON.parse(data)
	} catch (e) {
		return { state, data: 'bad_signal' }
	}
	if (signal.type === 'has_player') {
		const member = state.lobby.players.some((p) => p.id === signal.userId)
		return { state, data: member ? 'yes' : 'no' }
	}
	if (signal.type === 'leave') {
		const next = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			state,
			leave(state.lobby, signal.userId),
		)
		// A closed lobby's match ends at its next loop, which finds it closed.
		return {
			state: next || { ...state, lobby: { ...state.lobby, closed: true } },
			data: 'ok',
		}
	}
	return { state, data: 'bad_signal' }
}

export function lobbyMatchTerminate(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	dispatcher: nkruntime.MatchDispatcher,
	tickNumber: number,
	state: LobbyMatchState,
	graceSeconds: number,
) {
	apply(ctx, logger, nk, dispatcher, state, close(state.lobby))
	return { state }
}
