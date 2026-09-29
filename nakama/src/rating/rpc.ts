// Rating read RPCs: a player's own rating on a board, and a board's top.
import { INVALID_ARGUMENT, UNAUTHENTICATED, runtimeError } from '../errors'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { boardId, newRating, type RatingRecord } from './apply'
import { PLACEMENT_GAMES } from './elo'

const BOARD_PAGE = 50
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

// {modId, mode} -> the caller's rating record on that board (a fresh one if
// they haven't played it), plus whether they're still in placement games.
export function rpcRatingGet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	if (!ctx.userId) throw runtimeError(UNAUTHENTICATED, 'Rating RPCs need a player session')
	const { modId, mode } = boardOf(payload)
	const objects = nk.storageRead([
		{ collection: RATINGS_COLLECTION, key: boardId(modId, mode), userId: ctx.userId },
	])
	const rating = objects.length > 0 ? (objects[0].value as unknown as RatingRecord) : newRating()
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
		page = nk.leaderboardRecordsList(boardId(modId, mode), null, BOARD_PAGE, cursor, 0)
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
