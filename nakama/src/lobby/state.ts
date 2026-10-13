// The lobby rules, as pure functions over plain data: no Nakama calls, no
// clock (callers pass `now`), and every transition returns a new Lobby
// instead of mutating. Nakama round-trips match state through Go between
// calls, where Set/Map values are lost and in-place nested mutation can
// silently not stick, so the state holds only plain objects and arrays.
//
// Parity source: the API's MQTT lobbies (apps/server/src/features/lobby/
// lobby.service.ts and infrastructure/mqtt/grace-period.service.ts).
import {
	type GameState,
	type LobbyEventMessage,
	type LobbyEventType,
	type PlayerInfo,
	type PlayerLog,
	type RunRecord,
	ServerOp,
	type Snapshot,
} from './protocol'

export const DEFAULT_GRACE_MS = 120_000
// How long a started game waits for the rest of its results once the first
// report is in (or once it's down to fewer than two players).
export const DEFAULT_RESULT_TIMEOUT_MS = 60_000
// A created lobby nobody joins (the creator's client crashed between the
// create RPC and match_join) closes after this long.
export const CREATOR_JOIN_TIMEOUT_MS = 30_000
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 128

export interface ChatLine {
	senderId: string
	text: string
	// Absent on lines kept before reports needed them.
	displayName?: string
	at?: number
}

export interface LobbyPlayer {
	id: string
	// The presence currently attached; a stale session's leave is ignored.
	sessionId: string
	info: PlayerInfo
	awaySince: number | null
	ownState: unknown
}

export interface Lobby {
	code: string
	modId: string
	maxPlayers: number
	creatorId: string
	hostId: string
	// Set when the lobby was created ranked: the rating board its games count on.
	rankedMode?: string
	// Set when the matchmaker made the lobby: only these players may take a
	// seat, and each may do so before the first of them has arrived.
	allowedIds?: string[]
	// The queue a matchmade lobby came from, as the API keys it ('mode' or
	// 'ranked:mode'); queue_counts counts its players as in a match.
	gameMode?: string
	// Watching, not playing (spectate.ts): never seated, counted or ready.
	spectators?: string[]
	metadata: { [key: string]: unknown }
	// In join order: host transfer picks the earliest eligible player.
	players: LobbyPlayer[]
	kickedIds: string[]
	createdAt: number
	graceMs: number
	resultTimeoutMs: number
	closed: boolean
	// Owned by the authoritative actions (src/actions).
	game: GameState
	// The last few approved chat lines (chat.ts): the moderation context, and
	// a report's evidence.
	chat?: ChatLine[]
	// The last finished game's run, for a report filed after it ended.
	lastRunId?: string
	// userId -> the sender's ACTION rate-limit bucket (relay.ts).
	actionBudget: { [userId: string]: { tokens: number; at: number } }
}

export type Outbound =
	| { kind: 'send'; op: number; payload: unknown; to: string[] }
	| { kind: 'kick'; userId: string }
	| { kind: 'setCurrent'; userId: string }
	| { kind: 'clearCurrent'; userId: string }
	// A matchmade game's participant timed out (lobby/forfeits.ts).
	| { kind: 'forfeited'; userId: string; runId: string; code: string; at: number }
	| {
			kind: 'saveRun'
			run: RunRecord
			logs: { [userId: string]: PlayerLog }
	  }

export interface Step {
	lobby: Lobby
	out: Outbound[]
}

export function newLobby(params: {
	code: string
	modId: string
	maxPlayers: number
	creatorId: string
	rankedMode?: string
	allowedIds?: string[]
	gameMode?: string
	now: number
	graceMs: number
	resultTimeoutMs?: number
}): Lobby {
	return {
		code: params.code,
		modId: params.modId,
		maxPlayers: params.maxPlayers,
		creatorId: params.creatorId,
		hostId: params.creatorId,
		rankedMode: params.rankedMode,
		allowedIds: params.allowedIds,
		gameMode: params.gameMode,
		metadata: {},
		players: [],
		kickedIds: [],
		createdAt: params.now,
		graceMs: params.graceMs,
		resultTimeoutMs: params.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS,
		closed: false,
		game: emptyGame(),
		actionBudget: {},
	}
}

// No game running: nobody ready, no reports, no logs.
export function emptyGame(): GameState {
	return {
		ready: {},
		started: null,
		reports: {},
		reportOrder: [],
		settleFrom: null,
		logs: {},
	}
}

// The API's lobby types: the matchmaker makes 'public' lobbies, players make
// 'private' ones by code.
export function lobbyType(lobby: Lobby): 'public' | 'private' {
	return lobby.allowedIds ? 'public' : 'private'
}

// Public lobbies can always be watched; a private one when its host has set
// metadata.spectatable (as the API's /lobbies/spectatable decides).
export function isSpectatable(lobby: Lobby): boolean {
	return lobbyType(lobby) === 'public' || lobby.metadata.spectatable === true
}

// The match label, searchable with matchList queries (e.g.
// +label.modId:X +label.spectatable:T).
export function labelOf(lobby: Lobby): string {
	return JSON.stringify({
		code: lobby.code,
		modId: lobby.modId,
		type: lobbyType(lobby),
		mode: lobby.gameMode || '',
		open:
			!lobby.closed &&
			lobby.game.started === null &&
			lobby.players.length < lobby.maxPlayers,
		started: lobby.game.started !== null,
		size: lobby.players.length,
		max: lobby.maxPlayers,
		spectatable: isSpectatable(lobby),
		spectators: (lobby.spectators || []).length,
	})
}

export function findPlayer(
	lobby: Lobby,
	userId: string,
): LobbyPlayer | undefined {
	for (const p of lobby.players) {
		if (p.id === userId) return p
	}
	return undefined
}

function allIds(lobby: Lobby): string[] {
	return lobby.players.map((p) => p.id)
}

function othersThan(lobby: Lobby, userId: string): string[] {
	return allIds(lobby).filter((id) => id !== userId)
}

function event(
	lobby: Lobby,
	type: LobbyEventType,
	fields: Omit<LobbyEventMessage, 'type' | 'lobbyCode'>,
	to: string[],
): Outbound {
	const payload: LobbyEventMessage = { type, lobbyCode: lobby.code, ...fields }
	return { kind: 'send', op: ServerOp.EVENT, payload, to }
}

function rejectOp(userId: string, message: string): Outbound {
	return {
		kind: 'send',
		op: ServerOp.ERROR,
		payload: { message },
		to: [userId],
	}
}

// Why userId may not join, or null. A member rejoining (after a disconnect)
// is always let back in.
export function joinRejection(
	lobby: Lobby,
	userId: string,
	modId: string,
): string | null {
	if (lobby.closed) return 'Lobby is closed'
	if (findPlayer(lobby, userId)) return null
	if ((lobby.spectators || []).indexOf(userId) !== -1)
		return 'You are spectating this lobby'
	if (lobby.kickedIds.indexOf(userId) !== -1)
		return 'You were kicked from this lobby'
	if (modId !== lobby.modId) return 'Lobby is for a different mod'
	if (lobby.game.started) return 'The game has already started'
	if (lobby.allowedIds) {
		if (lobby.allowedIds.indexOf(userId) === -1)
			return 'This lobby is reserved for matched players'
	} else if (lobby.players.length === 0 && userId !== lobby.creatorId) {
		return 'Lobby is not open yet'
	}
	if (lobby.players.length >= lobby.maxPlayers) return 'Lobby is full'
	return null
}

export function snapshotFor(lobby: Lobby, userId: string): Snapshot {
	const self = findPlayer(lobby, userId)
	return {
		code: lobby.code,
		modId: lobby.modId,
		hostId: lobby.hostId,
		maxPlayers: lobby.maxPlayers,
		type: lobby.rankedMode ? 'ranked' : lobby.allowedIds ? 'public' : 'private',
		metadata: lobby.metadata,
		players: lobby.players.map((p) => ({
			id: p.id,
			displayName: p.info.displayName,
			preferredJoker: p.info.preferredJoker,
			mods: p.info.mods,
			isAway: p.awaySince !== null,
		})),
		ownState: self ? self.ownState : null,
		game: {
			ready: lobby.game.ready,
			started: lobby.game.started,
			reported: Object.keys(lobby.game.reports),
		},
	}
}

// Call after joinRejection returned null.
export function join(
	lobby: Lobby,
	userId: string,
	sessionId: string,
	info: PlayerInfo,
): Step {
	const existing = findPlayer(lobby, userId)
	if (existing) {
		const wasAway = existing.awaySince !== null
		const back: LobbyPlayer = { ...existing, sessionId, awaySince: null }
		const next = {
			...lobby,
			players: lobby.players.map((p) => (p.id === userId ? back : p)),
		}
		const out: Outbound[] = [
			{
				kind: 'send',
				op: ServerOp.SNAPSHOT,
				payload: snapshotFor(next, userId),
				to: [userId],
			},
		]
		if (wasAway) {
			out.push(
				event(
					next,
					'player_reconnected',
					{ playerId: userId, displayName: back.info.displayName },
					othersThan(next, userId),
				),
			)
		}
		return { lobby: next, out }
	}

	const player: LobbyPlayer = {
		id: userId,
		sessionId,
		info,
		awaySince: null,
		ownState: null,
	}
	// A matchmade lobby has no creator to wait for: whoever arrives first hosts.
	const next = {
		...lobby,
		hostId:
			lobby.allowedIds && lobby.players.length === 0 ? userId : lobby.hostId,
		players: lobby.players.concat([player]),
	}
	const others = othersThan(next, userId)
	return {
		lobby: next,
		out: [
			{ kind: 'setCurrent', userId },
			{
				kind: 'send',
				op: ServerOp.SNAPSHOT,
				payload: snapshotFor(next, userId),
				to: [userId],
			},
			event(
				next,
				'player_joined',
				{ playerId: userId, displayName: info.displayName },
				others,
			),
			{
				kind: 'send',
				op: ServerOp.PLAYER_INFO,
				payload: { playerId: userId, info },
				to: others,
			},
		],
	}
}

// The actionBudget key of a player's replay-log bucket (relay.ts), separate
// so a busy log stream can't starve their other actions.
export function logBudgetKey(userId: string): string {
	return `${userId}:log`
}

// Next host after `leavingId`: the earliest-joined player still connected
// (grace-period.service.ts findNextHost).
function nextHost(lobby: Lobby, leavingId: string): string | null {
	for (const p of lobby.players) {
		if (p.id !== leavingId && p.awaySince === null) return p.id
	}
	return null
}

function transferHostFrom(lobby: Lobby, userId: string): Step {
	if (lobby.hostId !== userId) return { lobby, out: [] }
	const hostId = nextHost(lobby, userId)
	if (!hostId) return { lobby, out: [] }
	const next = { ...lobby, hostId }
	return {
		lobby: next,
		out: [event(next, 'host_changed', { playerId: hostId }, allIds(next))],
	}
}

export function close(lobby: Lobby): Step {
	if (lobby.closed) return { lobby, out: [] }
	const next = { ...lobby, closed: true }
	// Spectators hear it too: the match ends with it.
	const out: Outbound[] = [
		event(next, 'lobby_closed', {}, allIds(next).concat(next.spectators || [])),
	]
	for (const id of allIds(next)) out.push({ kind: 'clearCurrent', userId: id })
	return { lobby: next, out }
}

// A lobby nobody is connected to any more is closed straight away rather than
// waiting out every player's grace period (grace-period.service.ts, "§7.8").
function closeIfAbandoned(step: Step): Step {
	const lobby = step.lobby
	if (lobby.closed) return step
	const anyoneHere = lobby.players.some((p) => p.awaySince === null)
	if (anyoneHere) return step
	const closed = close(lobby)
	return { lobby: closed.lobby, out: step.out.concat(closed.out) }
}

// Drops userId from the roster: `type` is the event the others get
// (player_left, or none when the caller already announced a kick).
function remove(
	lobby: Lobby,
	userId: string,
	type: 'player_left' | null,
): Step {
	const player = findPlayer(lobby, userId)
	if (!player) return { lobby, out: [] }

	// Host moves on before the player is gone, so the new host is never them.
	const transferred = transferHostFrom(lobby, userId)
	const ready = { ...transferred.lobby.game.ready }
	delete ready[userId]
	const actionBudget = { ...transferred.lobby.actionBudget }
	delete actionBudget[userId]
	delete actionBudget[logBudgetKey(userId)]
	const next = {
		...transferred.lobby,
		players: transferred.lobby.players.filter((p) => p.id !== userId),
		game: { ...transferred.lobby.game, ready },
		actionBudget,
	}
	const others = allIds(next)
	const out: Outbound[] = [{ kind: 'clearCurrent', userId }]
	if (type)
		out.push(
			event(
				next,
				type,
				{ playerId: userId, displayName: player.info.displayName },
				others,
			),
		)
	out.push({
		kind: 'send',
		op: ServerOp.PLAYER_INFO,
		payload: { playerId: userId, info: null },
		to: others,
	})
	out.push(
		...transferred.out.map((o) =>
			o.kind === 'send' ? { ...o, to: others } : o,
		),
	)

	if (next.players.length === 0) {
		const closed = close(next)
		return { lobby: closed.lobby, out: out.concat(closed.out) }
	}
	return closeIfAbandoned({ lobby: next, out })
}

// The player asked to leave (op LEAVE, or the leave RPC): gone for good.
export function leave(lobby: Lobby, userId: string): Step {
	if (!findPlayer(lobby, userId)) return { lobby, out: [] }
	const step = remove(lobby, userId, 'player_left')
	return { lobby: step.lobby, out: step.out.concat([{ kind: 'kick', userId }]) }
}

// The player's socket dropped without a LEAVE: keep their seat for the grace
// period. A leave from an older session of a player who already rejoined is
// stale and ignored.
export function disconnect(
	lobby: Lobby,
	userId: string,
	sessionId: string,
	now: number,
): Step {
	const player = findPlayer(lobby, userId)
	if (!player || player.sessionId !== sessionId || player.awaySince !== null)
		return { lobby, out: [] }

	const away: LobbyPlayer = { ...player, awaySince: now }
	const marked = {
		...lobby,
		players: lobby.players.map((p) => (p.id === userId ? away : p)),
	}
	const transferred = transferHostFrom(marked, userId)
	const out: Outbound[] = [
		event(
			transferred.lobby,
			'player_disconnected',
			{ playerId: userId, displayName: player.info.displayName },
			othersThan(transferred.lobby, userId),
		),
	]
	return closeIfAbandoned({
		lobby: transferred.lobby,
		out: out.concat(transferred.out),
	})
}

export function kick(lobby: Lobby, byId: string, targetId: string): Step {
	if (lobby.hostId !== byId)
		return { lobby, out: [rejectOp(byId, 'Only the host can kick players')] }
	if (targetId === byId)
		return { lobby, out: [rejectOp(byId, 'You cannot kick yourself')] }
	if (!findPlayer(lobby, targetId))
		return { lobby, out: [rejectOp(byId, 'Player is not in this lobby')] }
	return removeKicked(lobby, targetId, { kickedBy: byId })
}

// Announced to everyone, the target included, before they are removed; they
// may not come back.
function removeKicked(lobby: Lobby, targetId: string, data: { [key: string]: unknown }): Step {
	const target = findPlayer(lobby, targetId)
	if (!target) return { lobby, out: [] }
	const announced = event(
		lobby,
		'player_kicked',
		{ playerId: targetId, displayName: target.info.displayName, data },
		allIds(lobby),
	)
	const marked = { ...lobby, kickedIds: lobby.kickedIds.concat([targetId]) }
	const step = remove(marked, targetId, null)
	return {
		lobby: step.lobby,
		out: [announced as Outbound].concat(step.out, [
			{ kind: 'kick', userId: targetId },
		]),
	}
}

// The server (an admin, or a ban) takes userId out. With onlyIfStarted, only
// out of a running game: a queue ban forfeits the game but leaves an idle
// lobby alone. Leaving a started game is its forfeit: the result clock and
// the others' reports settle it (actions/results.ts).
export function adminRemove(
	lobby: Lobby,
	userId: string,
	reason: string,
	onlyIfStarted = false,
): Step {
	if (onlyIfStarted && lobby.game.started === null) return { lobby, out: [] }
	return removeKicked(lobby, userId, { kickedBy: 'server', reason })
}

// What webadmin shows of a lobby beyond its label.
export function adminView(lobby: Lobby) {
	return {
		code: lobby.code,
		modId: lobby.modId,
		hostId: lobby.hostId,
		maxPlayers: lobby.maxPlayers,
		createdAt: lobby.createdAt,
		metadata: lobby.metadata,
		started: lobby.game.started !== null,
		players: lobby.players.map((p) => ({
			id: p.id,
			displayName: p.info.displayName,
			connected: p.awaySince === null,
		})),
		spectators: lobby.spectators || [],
	}
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function setMetadata(lobby: Lobby, byId: string, patch: unknown): Step {
	if (lobby.hostId !== byId)
		return { lobby, out: [rejectOp(byId, 'Only the host can set metadata')] }
	if (!isPlainObject(patch))
		return { lobby, out: [rejectOp(byId, 'Metadata must be an object')] }

	const metadata = { ...lobby.metadata, ...patch }
	const next = { ...lobby, metadata }
	const everyone = allIds(next)
	return {
		lobby: next,
		out: [
			{ kind: 'send', op: ServerOp.METADATA, payload: metadata, to: everyone },
			event(next, 'metadata_changed', { data: metadata }, everyone),
		],
	}
}

export function setOwnState(lobby: Lobby, byId: string, state: unknown): Step {
	if (!findPlayer(lobby, byId)) return { lobby, out: [] }
	return {
		lobby: {
			...lobby,
			players: lobby.players.map((p) =>
				p.id === byId ? { ...p, ownState: state } : p,
			),
		},
		out: [],
	}
}

// A player's info changed outside the match (their profile: display name,
// joker, mods). Everyone, the player included, gets the new info.
export function setPlayerInfo(lobby: Lobby, userId: string, patch: Partial<PlayerInfo>): Step {
	const player = findPlayer(lobby, userId)
	if (!player) return { lobby, out: [] }
	const info: PlayerInfo = { ...player.info, ...patch }
	return {
		lobby: {
			...lobby,
			players: lobby.players.map((p) => (p.id === userId ? { ...p, info } : p)),
		},
		out: [{ kind: 'send', op: ServerOp.PLAYER_INFO, payload: { playerId: userId, info }, to: allIds(lobby) }],
	}
}

// Time passing: expire grace periods, and close a lobby its creator never
// joined.
export function tick(lobby: Lobby, now: number): Step {
	if (lobby.closed) return { lobby, out: [] }
	if (lobby.players.length === 0) {
		return now - lobby.createdAt >= CREATOR_JOIN_TIMEOUT_MS
			? close(lobby)
			: { lobby, out: [] }
	}

	let step: Step = { lobby, out: [] }
	for (const p of lobby.players) {
		if (step.lobby.closed) break
		if (p.awaySince !== null && now - p.awaySince >= lobby.graceMs) {
			const started = step.lobby.game.started
			const forfeited: Outbound[] =
				started && lobby.gameMode && started.players.some((q) => q.id === p.id)
					? [{ kind: 'forfeited', userId: p.id, runId: started.runId, code: lobby.code, at: now }]
					: []
			const removed = remove(step.lobby, p.id, 'player_left')
			step = { lobby: removed.lobby, out: step.out.concat(forfeited, removed.out) }
		}
	}
	return step
}
