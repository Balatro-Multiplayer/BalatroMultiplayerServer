// The bmp_lobby authoritative match: adapts Nakama's match callbacks to the
// pure rules in state.ts and carries out the Outbound effects they return.
// One match per lobby; the match ends (returns null) once the lobby closes.
import { seedFromHex } from '../actions/registry'
import { finishGame, settle } from '../actions/results'
import { activeRunOf } from './active'
import { checkpointOf, readCheckpoint, resumeFrom, saveCheckpoint } from './checkpoint'
import { releaseCode } from './codes'
import {
	CURRENT_LOBBY_COLLECTION,
	CURRENT_LOBBY_KEY,
	ClientOp,
	ServerOp,
	type LobbySignal,
	type PlayerInfo,
	type PlayerLog,
	type RunRecord,
} from './protocol'
import { action } from './relay'
import {
	DEFAULT_GRACE_MS,
	DEFAULT_RESULT_TIMEOUT_MS,
	type Lobby,
	type Outbound,
	type Step,
	adminRemove,
	adminView,
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
	setPlayerInfo,
	tick,
} from './state'
import { displayNameOf, readProfile } from '../player/profile'
import { applyRatings } from '../rating/apply'
import { currentSeason } from '../rating/season'
import { enqueue } from '../mirror/outbox'
import { chatCheck, chatPost, reportEvidence } from './chat'
import {
	SPECTATOR_ROLE,
	addSpectator,
	isSpectator,
	removeSpectator,
	spectateRejection,
} from './spectate'
import { runFlags } from './anticheat'
import { recordForfeit } from './forfeits'
import { logChecksOf, saveRun } from './storage'

const TICK_RATE = 5
const MAX_MESSAGE_BYTES = 64 * 1024

export interface LobbyMatchState extends nkruntime.MatchState {
	lobby: Lobby
	// userId -> the presence currently attached.
	presences: { [userId: string]: nkruntime.Presence }
	// Player info from matchJoinAttempt's metadata, consumed by matchJoin
	// (which gets no metadata of its own).
	pendingInfo: { [userId: string]: PlayerInfo }
	// Users let in as spectators by matchJoinAttempt, until matchJoin.
	pendingSpectators?: string[]
	label: string
	// Set once the lobby has checkpointed for a server restart: the next loop
	// ends the match (matchTerminate itself must hand back a state).
	stopping?: boolean
}

function secondsFromEnv(
	ctx: nkruntime.Context,
	name: string,
	fallbackMs: number,
): number {
	const seconds = Number(ctx.env[name])
	return seconds > 0 ? seconds * 1000 : fallbackMs
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
	raw: Step,
): LobbyMatchState | null {
	// A lobby that closes mid-game still stores the game.
	let step = raw
	if (step.lobby.closed && step.lobby.game.started) {
		const finished = finishGame(step.lobby, Date.now())
		step = { lobby: finished.lobby, out: step.out.concat(finished.out) }
	}
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
	return { ...state, lobby: step.lobby, presences, label }
}

// A finished run is flagged (lobby/anticheat.ts) and, for a ranked game,
// rated before it's stored, so the run and each player's pointer carry what
// it did to their rating. A rating failure must not lose the run, so it
// leaves the run unrated instead.
function judged(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	run: RunRecord,
	logs: { [userId: string]: PlayerLog },
): RunRecord {
	const flags = runFlags(run, logs, logChecksOf(run, logs, (input) => nk.sha256Hash(input)))
	const flagged = { ...run, flags }
	if (!run.rankedMode) return flagged
	try {
		return { ...flagged, ratings: applyRatings(nk, logger, run, run.rankedMode, flags) }
	} catch (e) {
		logger.error('Could not rate run %s: %v', run.runId, e)
		return flagged
	}
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
		case 'saveRun':
			try {
				const run = judged(nk, logger, effect.run, effect.logs)
				saveRun(nk, run, effect.logs)
				enqueue(nk, {
					kind: 'run',
					at: Date.now(),
					runId: run.runId,
					rating: run.rankedMode ? { modId: run.modId, mode: run.rankedMode, season: currentSeason(nk) } : null,
				})
				for (const playerId in run.flags) {
					logger.warn('Lobby %s: run %s: %s is flagged (%s)', lobby.code, run.runId, playerId, run.flags[playerId])
				}
			} catch (e) {
				logger.error(
					'Lobby %s: could not store run %s: %v',
					lobby.code,
					effect.run.runId,
					e,
				)
			}
			return
		case 'forfeited':
			try {
				recordForfeit(nk, effect.userId, { runId: effect.runId, code: effect.code, at: effect.at })
			} catch (e) {
				logger.warn('Lobby %s: could not record %s timing out: %v', lobby.code, effect.userId, e)
			}
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
	const resumeCode = stringParam(params, 'resumeCode')
	const found = resumeCode ? readCheckpoint(nk, resumeCode) : null
	const lobby = found ? resumeFrom(found.checkpoint, Date.now()) : newLobby({
		code: stringParam(params, 'code'),
		modId: stringParam(params, 'modId'),
		maxPlayers: Number(params.maxPlayers),
		creatorId: stringParam(params, 'creatorId'),
		rankedMode: stringParam(params, 'rankedMode') || undefined,
		allowedIds: stringParam(params, 'allowedIds')
			? stringParam(params, 'allowedIds').split(',')
			: undefined,
		gameMode: stringParam(params, 'gameMode') || undefined,
		now: Date.now(),
		graceMs: secondsFromEnv(ctx, 'LOBBY_GRACE_SECONDS', DEFAULT_GRACE_MS),
		resultTimeoutMs: secondsFromEnv(
			ctx,
			'RESULT_TIMEOUT_SECONDS',
			DEFAULT_RESULT_TIMEOUT_MS,
		),
	})
	const label = labelOf(lobby)
	const state: LobbyMatchState = {
		lobby,
		presences: {},
		pendingInfo: {},
		label,
	}
	if (found) logger.info('Lobby %s resumed for %s', lobby.code, lobby.modId)
	else logger.info('Lobby %s created for %s', lobby.code, lobby.modId)
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

// The joining player's info. Their profile (player/profile.ts), once they
// have logged in through session_init, decides the name and joker; the
// metadata only fills in for players who logged in through the API, and for
// mods.
export function joinInfoOf(
	nk: nkruntime.Nakama,
	presence: nkruntime.Presence,
	meta: { [key: string]: string },
): PlayerInfo {
	const sentMods = parseMods(meta.mods)
	const stored = readProfile(nk, presence.userId, presence.username)
	if (stored && stored.profile.nakamaLogin) {
		return {
			displayName: displayNameOf(stored.profile),
			preferredJoker: stored.profile.preferredJoker,
			mods: sentMods !== null ? sentMods : stored.profile.mods,
		}
	}
	return {
		displayName: meta.displayName || presence.username,
		preferredJoker: meta.preferredJoker || null,
		mods: sentMods,
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
	if (meta.role === SPECTATOR_ROLE) {
		const refused = spectateRejection(state.lobby, presence.userId)
		if (refused) return { state, accept: false, rejectMessage: refused }
		const pending = (state.pendingSpectators || []).filter((id) => id !== presence.userId)
		return {
			state: { ...state, pendingSpectators: pending.concat([presence.userId]) },
			accept: true,
		}
	}
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

	const info = joinInfoOf(nk, presence, meta)
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
		const pendingSpectators = current.pendingSpectators || []
		if (pendingSpectators.indexOf(presence.userId) !== -1) {
			const watching = {
				...current,
				pendingSpectators: pendingSpectators.filter((id) => id !== presence.userId),
				presences: { ...current.presences, [presence.userId]: presence },
			}
			current = apply(ctx, logger, nk, dispatcher, watching, addSpectator(watching.lobby, presence.userId))
			continue
		}
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
			const remaining: { [userId: string]: nkruntime.Presence } = { ...current.presences }
			delete remaining[presence.userId]
			current = { ...current, presences: remaining }
		}
		if (isSpectator(current.lobby, presence.userId)) {
			if (attached && attached.sessionId === presence.sessionId)
				current = apply(ctx, logger, nk, dispatcher, current, removeSpectator(current.lobby, presence.userId))
			continue
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
				newId: () => nk.uuidv4(),
			})
		case ClientOp.LEAVE:
			if (isSpectator(lobby, senderId)) {
				const stopped = removeSpectator(lobby, senderId)
				return { lobby: stopped.lobby, out: [{ kind: 'kick', userId: senderId }] }
			}
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
	if (state.stopping) return null
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
	const now = Date.now()
	const ticked = apply(ctx, logger, nk, dispatcher, current, tick(current.lobby, now))
	if (!ticked) return null
	const settled = apply(
		ctx,
		logger,
		nk,
		dispatcher,
		ticked,
		settle(ticked.lobby, now),
	)
	return settled ? { state: settled } : null
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
	if (signal.type === 'get_active') {
		return { state, data: JSON.stringify(activeRunOf(state.lobby, signal.userId)) }
	}
	if (signal.type === 'chat_check') {
		const check = chatCheck(state.lobby, signal.userId, Date.now())
		if (!check.ok) return { state, data: JSON.stringify({ error: check.reason }) }
		return {
			state: { ...state, lobby: check.lobby },
			data: JSON.stringify({
				code: check.lobby.code,
				displayName: check.displayName,
				context: check.context,
			}),
		}
	}
	if (signal.type === 'chat_post') {
		const next = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			state,
			chatPost(state.lobby, signal.userId, signal.text, Date.now()),
		)
		return { state: next || state, data: 'ok' }
	}
	if (signal.type === 'player_info') {
		const next = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			state,
			setPlayerInfo(state.lobby, signal.userId, signal.info),
		)
		return { state: next || state, data: 'ok' }
	}
	if (signal.type === 'admin_remove') {
		const member = state.lobby.players.some((p) => p.id === signal.userId)
		const next = apply(
			ctx,
			logger,
			nk,
			dispatcher,
			state,
			adminRemove(state.lobby, signal.userId, signal.reason, signal.onlyIfStarted === true),
		)
		return {
			state: next || { ...state, lobby: { ...state.lobby, closed: true } },
			data: member ? 'ok' : 'not_member',
		}
	}
	if (signal.type === 'report_evidence') {
		const check = reportEvidence(state.lobby, signal.reporterId, signal.reportedId)
		return { state, data: JSON.stringify(check.ok ? check.evidence : { error: check.reason }) }
	}
	if (signal.type === 'admin_view') return { state, data: JSON.stringify(adminView(state.lobby)) }
	if (signal.type === 'admin_close') {
		const next = apply(ctx, logger, nk, dispatcher, state, close(state.lobby))
		return {
			state: next || { ...state, lobby: { ...state.lobby, closed: true } },
			data: 'ok',
		}
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
	// A server shutdown (shutdown_grace_sec > 0): keep the lobby for the
	// server that comes back (lobby/checkpoint.ts) rather than closing it,
	// so a running game isn't ended as abandoned.
	if (graceSeconds > 0) {
		const checkpoint = checkpointOf(state.lobby, Date.now())
		if (checkpoint) {
			try {
				saveCheckpoint(nk, checkpoint)
				const targets = Object.keys(state.presences).map((id) => state.presences[id])
				if (targets.length > 0)
					dispatcher.broadcastMessage(
						ServerOp.SERVER_RESTARTING,
						JSON.stringify({ graceSeconds }),
						targets,
						null,
						true,
					)
				logger.info('Lobby %s checkpointed for the restart', state.lobby.code)
				return { state: { ...state, stopping: true } }
			} catch (e) {
				logger.error('Lobby %s: could not checkpoint: %v', state.lobby.code, e)
			}
		}
	}
	apply(ctx, logger, nk, dispatcher, state, close(state.lobby))
	return { state }
}
