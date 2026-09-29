// Lobby RPCs. Joining itself is a socket match_join on the id lobby_find (or
// lobby_create) returns; these only find, create and leave matches.
import {
	ALREADY_EXISTS,
	INVALID_ARGUMENT,
	NOT_FOUND,
	PERMISSION_DENIED,
	UNAUTHENTICATED,
	UNAVAILABLE,
	runtimeError,
} from '../errors'
import { bindCode, lookupCode, releaseCode, reserveCode } from './codes'
import {
	CURRENT_LOBBY_COLLECTION,
	CURRENT_LOBBY_KEY,
	LOBBY_MATCH,
	type LobbySignal,
} from './protocol'
import { MAX_PLAYERS, MIN_PLAYERS } from './state'

// Same alphabet as the API's generateLobbyCode (no I or O), and the same
// lengths: 6 for manual lobbies, 5 for matchmade ones.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789'
const CODE_LENGTH = 6
export const MATCHMADE_CODE_LENGTH = 5
const CODE_PATTERN = /^[A-HJ-NP-Z1-9]{5,6}$/
export const CODE_ATTEMPTS = 10
const MOD_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const DEFAULT_MAX_PLAYERS = 16
const RANKED_MODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

export function generateCode(length: number = CODE_LENGTH): string {
	let code = ''
	for (let i = 0; i < length; i++) {
		code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length))
	}
	return code
}

function requireUser(ctx: nkruntime.Context): string {
	if (!ctx.userId)
		throw runtimeError(UNAUTHENTICATED, 'Lobby RPCs need a player session')
	return ctx.userId
}

function parsePayload(payload: string): { [key: string]: unknown } {
	if (!payload) return {}
	try {
		const data = JSON.parse(payload)
		if (typeof data === 'object' && data !== null && !Array.isArray(data))
			return data
	} catch (e) {
		// Falls through to the error below.
	}
	throw runtimeError(INVALID_ARGUMENT, 'Payload must be a JSON object')
}

// The lobby the user is still seated in, per their current-lobby record, or
// null (clearing a record that no longer holds).
export function currentLobby(
	nk: nkruntime.Nakama,
	userId: string,
): { matchId: string; code: string; modId: string } | null {
	const key = {
		collection: CURRENT_LOBBY_COLLECTION,
		key: CURRENT_LOBBY_KEY,
		userId,
	}
	const objects = nk.storageRead([key])
	if (objects.length === 0) return null
	const matchId = objects[0].value.matchId
	const code = objects[0].value.code
	const modId = String(objects[0].value.modId || '')
	if (
		typeof matchId === 'string' &&
		typeof code === 'string' &&
		nk.matchGet(matchId)
	) {
		const signal: LobbySignal = { type: 'has_player', userId }
		if (nk.matchSignal(matchId, JSON.stringify(signal)) === 'yes')
			return { matchId, code, modId }
	}
	nk.storageDelete([key])
	return null
}

export function rpcLobbyCreate(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const input = parsePayload(payload)

	const modId = input.modId
	if (typeof modId !== 'string' || !MOD_ID_PATTERN.test(modId)) {
		throw runtimeError(INVALID_ARGUMENT, 'modId is required')
	}
	const maxPlayers =
		input.maxPlayers === undefined || input.maxPlayers === null
			? DEFAULT_MAX_PLAYERS
			: input.maxPlayers
	if (
		typeof maxPlayers !== 'number' ||
		maxPlayers % 1 !== 0 ||
		maxPlayers < MIN_PLAYERS ||
		maxPlayers > MAX_PLAYERS
	) {
		throw runtimeError(
			INVALID_ARGUMENT,
			`maxPlayers must be a whole number from ${MIN_PLAYERS} to ${MAX_PLAYERS}`,
		)
	}

	// Ranked lobbies count on a rating board. The matchmaker creates the real
	// ones; only a server run with ALLOW_RANKED_LOBBIES=true (dev) lets a
	// client ask for one directly.
	const rankedMode = input.rankedMode
	if (rankedMode !== undefined && rankedMode !== null) {
		if (typeof rankedMode !== 'string' || !RANKED_MODE_PATTERN.test(rankedMode))
			throw runtimeError(INVALID_ARGUMENT, 'rankedMode is not a valid mode')
		if (ctx.env.ALLOW_RANKED_LOBBIES !== 'true')
			throw runtimeError(PERMISSION_DENIED, 'Ranked lobbies are not enabled')
	}

	const current = currentLobby(nk, userId)
	if (current)
		throw runtimeError(ALREADY_EXISTS, `Already in lobby ${current.code}`)

	for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
		const code = generateCode()
		if (!reserveCode(nk, code, modId)) continue
		let matchId: string
		try {
			matchId = nk.matchCreate(LOBBY_MATCH, {
				code,
				modId,
				maxPlayers,
				creatorId: userId,
				rankedMode: typeof rankedMode === 'string' ? rankedMode : '',
			})
		} catch (e) {
			releaseCode(nk, code, '')
			throw e
		}
		bindCode(nk, code, matchId, modId)
		return JSON.stringify({ matchId, code })
	}
	logger.error(
		'Could not find a free lobby code after %d attempts',
		CODE_ATTEMPTS,
	)
	throw runtimeError(UNAVAILABLE, 'Could not allocate a lobby code')
}

export function rpcLobbyFind(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireUser(ctx)
	const input = parsePayload(payload)
	const code = typeof input.code === 'string' ? input.code.toUpperCase() : ''
	if (!CODE_PATTERN.test(code))
		throw runtimeError(INVALID_ARGUMENT, 'Invalid lobby code')

	const entry = lookupCode(nk, code)
	if (!entry) throw runtimeError(NOT_FOUND, 'Lobby not found')
	return JSON.stringify({ matchId: entry.matchId, code, modId: entry.modId })
}

export function rpcLobbyCurrent(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const current = currentLobby(nk, requireUser(ctx))
	return JSON.stringify(current || {})
}

// {} when the caller isn't in a running game, else {active: {runId, code,
// modId, events}}: what the reconnect prompt needs to catch a restarted client
// up (the API's GET /runs/mine/active, on Nakama).
export function rpcRunActive(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const current = currentLobby(nk, userId)
	if (!current) return JSON.stringify({})
	const signal: LobbySignal = { type: 'get_active', userId }
	const active = JSON.parse(nk.matchSignal(current.matchId, JSON.stringify(signal)))
	return JSON.stringify(active ? { active } : {})
}

// Leave the current lobby without joining its match first (the reconnect
// prompt's Leave button after a game restart).
export function rpcLobbyLeave(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const current = currentLobby(nk, userId)
	if (current) {
		const signal: LobbySignal = { type: 'leave', userId }
		nk.matchSignal(current.matchId, JSON.stringify(signal))
	}
	return JSON.stringify({})
}
