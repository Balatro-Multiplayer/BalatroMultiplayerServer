// Admin RPC that overwrites a board's ratings: the API recomputes them when a
// moderator voids a match (it keeps the full match history; Nakama purges old
// runs) and sends the result here.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { RATINGS_COLLECTION } from '../lobby/protocol'
import { parsePayload, requireServer } from '../rpc'
import { boardId, type RatingRecord } from './apply'
import { PLACEMENT_GAMES } from './elo'

const USER_ID_PATTERN = /^[0-9a-f-]{36}$/
const MODE_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/
const MAX_ENTRIES = 1000

// One player's new rating on the board, or null to clear it.
export interface RatingsSetEntry {
	userId: string
	name: string
	record: RatingRecord | null
}

export interface RatingsSet {
	modId: string
	mode: string
	season: number
	entries: RatingsSetEntry[]
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function recordOf(value: unknown): RatingRecord | null | undefined {
	if (value === null) return null
	if (typeof value !== 'object' || Array.isArray(value)) return undefined
	const r = value as { [key: string]: unknown }
	if (typeof r.rating !== 'number' || !Number.isFinite(r.rating)) return undefined
	if (!isCount(r.wins) || !isCount(r.losses) || !isCount(r.gamesPlayed) || !isCount(r.lastMatchAt)) return undefined
	if (r.seasonBest !== null && (typeof r.seasonBest !== 'number' || !Number.isFinite(r.seasonBest))) return undefined
	return {
		rating: r.rating,
		wins: r.wins,
		losses: r.losses,
		gamesPlayed: r.gamesPlayed,
		seasonBest: r.seasonBest as number | null,
		lastMatchAt: r.lastMatchAt,
	}
}

// Pure: the validated request, or the reason it was refused.
export function parseRatingsSet(input: { [key: string]: unknown }): RatingsSet | string {
	const { modId, mode, season, entries } = input
	if (typeof modId !== 'string' || modId === '' || typeof mode !== 'string' || !MODE_PATTERN.test(mode))
		return 'modId and mode are required'
	if (typeof season !== 'number' || !Number.isInteger(season) || season < 1) return 'season must be a positive integer'
	if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return `entries must be a list of at most ${MAX_ENTRIES}`
	const parsed: RatingsSetEntry[] = []
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) return 'Each entry must be an object'
		const { userId, name, record } = entry as { [key: string]: unknown }
		if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) return 'Each entry needs a userId'
		const parsedRecord = recordOf(record)
		if (parsedRecord === undefined) return `Invalid record for ${userId}`
		parsed.push({ userId, name: typeof name === 'string' ? name : '', record: parsedRecord })
	}
	return { modId, mode, season, entries: parsed }
}

// {modId, mode, season, entries: [{userId, name, record | null}]} -> {written, cleared}.
// Overwrites each player's stored rating (no version check: the API's copy is
// the one to keep) and their leaderboard record to match.
export function rpcAdminRatingsSet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const request = parseRatingsSet(parsePayload(payload))
	if (typeof request === 'string') throw runtimeError(INVALID_ARGUMENT, request)
	const key = boardId(request.modId, request.mode, request.season)
	const written = request.entries.filter((e) => e.record !== null)
	const cleared = request.entries.filter((e) => e.record === null)
	if (written.length > 0) {
		nk.storageWrite(
			written.map((e) => ({
				collection: RATINGS_COLLECTION,
				key,
				userId: e.userId,
				value: e.record as unknown as { [key: string]: unknown },
				permissionRead: 2,
				permissionWrite: 0,
			})),
		)
	}
	if (cleared.length > 0) {
		nk.storageDelete(cleared.map((e) => ({ collection: RATINGS_COLLECTION, key, userId: e.userId })))
	}
	nk.leaderboardCreate(key, true, 'desc', 'set', null, { modId: request.modId, mode: request.mode })
	for (const e of request.entries) {
		const record = e.record
		if (record && record.gamesPlayed >= PLACEMENT_GAMES) {
			nk.leaderboardRecordWrite(key, e.userId, e.name, record.rating, record.wins, {
				losses: record.losses,
				gamesPlayed: record.gamesPlayed,
				seasonBest: record.seasonBest,
			}, 'set')
		} else {
			try {
				nk.leaderboardRecordDelete(key, e.userId)
			} catch (err) {
				// Never on the board.
			}
		}
	}
	logger.info('Ratings on %s set by the API: %d written, %d cleared', key, written.length, cleared.length)
	return JSON.stringify({ written: written.length, cleared: cleared.length })
}
