// Rating read RPCs: a player's own rating on a board, and a board's top.
import { INVALID_ARGUMENT, UNAUTHENTICATED, runtimeError } from '../errors'
import { boardId, loadRatings, newRating } from './apply'
import { currentSeason } from './season'
import { PLACEMENT_GAMES } from './elo'

const BOARD_PAGE = 50
const USER_ID_PATTERN = /^[0-9a-f-]{36}$/
const MODE_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/

function boardOf(payload: string): { modId: string; mode: string; input: { [key: string]: unknown } } {
	let input: { [key: string]: unknown } = {}
	try {
		const data = payload ? JSON.parse(payload) : {}
		if (typeof data === 'object' && data !== null && !Array.isArray(data)) input = data
	} catch (e) {
		throw runtimeError(INVALID_ARGUMENT, 'Payload must be a JSON object')
	}
	const { modId, mode } = input
	if (typeof modId !== 'string' || typeof mode !== 'string' || !MODE_PATTERN.test(mode))
		throw runtimeError(INVALID_ARGUMENT, 'modId and mode are required')
	return { modId, mode, input }
}

// {modId, mode, playerId?} -> the player's (default: the caller's) rating record on that board (a fresh one if
// they haven't played it), plus whether they're still in placement games.
export function rpcRatingGet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	if (!ctx.userId) throw runtimeError(UNAUTHENTICATED, 'Rating RPCs need a player session')
	const { modId, mode, input } = boardOf(payload)
	// Ratings are public: a lobby's players read each other's (the card info
	// shown for an opponent). Default is the caller's own.
	const playerId = input.playerId === undefined ? ctx.userId : input.playerId
	if (typeof playerId !== 'string' || !USER_ID_PATTERN.test(playerId))
		throw runtimeError(INVALID_ARGUMENT, 'playerId is not a user id')
	const rating = loadRatings(nk, modId, mode, [playerId], Date.now(), currentSeason(nk)).current[playerId] || newRating()
	return JSON.stringify({ ...rating, isPlacement: rating.gamesPlayed < PLACEMENT_GAMES })
}

// {modId, mode, cursor?} -> {entries: [{rank, playerId, name, rating, wins,
// losses, gamesPlayed, seasonBest}], cursor}. Only players past their
// placement games are on a board.
export function rpcLeaderboardGet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	if (!ctx.userId) throw runtimeError(UNAUTHENTICATED, 'Rating RPCs need a player session')
	const { modId, mode, input } = boardOf(payload)
	const cursor = typeof input.cursor === 'string' ? input.cursor : ''
	let page: ReturnType<nkruntime.Nakama['leaderboardRecordsList']>
	try {
		page = nk.leaderboardRecordsList(boardId(modId, mode, currentSeason(nk)), null, BOARD_PAGE, cursor, 0)
	} catch (e) {
		// The board is created by the first rated game.
		return JSON.stringify({ entries: [], cursor: '' })
	}
	return JSON.stringify({
		entries: (page.records || []).map((r) => ({
			rank: r.rank,
			playerId: r.ownerId,
			name: r.username,
			rating: r.score,
			wins: r.subscore,
			losses: r.metadata.losses,
			gamesPlayed: r.metadata.gamesPlayed,
			seasonBest: r.metadata.seasonBest,
		})),
		cursor: page.nextCursor || '',
	})
}
