// Carries the Express server's ratings over to Nakama. The legacy database
// knows players only by sha256(steamId + PLAYER_ID_SALT), which can't be
// reversed into the "steam:<id>" custom ids Nakama accounts use. So the
// import parks each player's ratings in a system-owned collection keyed by
// that hash, and the player claims them at their first Nakama login, when
// their Steam id is known and can be hashed the same way.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { RATINGS_COLLECTION, SYSTEM_USER_ID } from '../lobby/protocol'
import { requireServer } from '../rpc'
import { boardId, type RatingRecord } from './apply'
import { PLACEMENT_GAMES } from './elo'

export const LEGACY_RATINGS_COLLECTION = 'legacy_ratings'
const STEAM_CUSTOM_ID_PREFIX = 'steam:'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const IMPORT_BATCH_LIMIT = 100

export interface LegacyBoard {
	modId: string
	mode: string
	season: number
	rating: number
	wins: number
	losses: number
	gamesPlayed: number
	seasonBest: number | null
	lastMatchAt: number
}

// What the importer parks per player. claimedBy is set once they've claimed.
export interface LegacyPlayer {
	boards: LegacyBoard[]
	claimedBy?: string
	claimedAt?: number
}

export function steamIdHash(nk: nkruntime.Nakama, salt: string, steamId: string): string {
	return nk.sha256Hash(steamId + salt)
}

function isLegacyBoard(value: unknown): value is LegacyBoard {
	const b = value as LegacyBoard
	return (
		typeof b === 'object' &&
		b !== null &&
		typeof b.modId === 'string' &&
		typeof b.mode === 'string' &&
		Number.isInteger(b.season) &&
		b.season > 0 &&
		Number.isFinite(b.rating) &&
		Number.isInteger(b.wins) &&
		Number.isInteger(b.losses) &&
		Number.isInteger(b.gamesPlayed) &&
		Number.isFinite(b.lastMatchAt) &&
		(b.seasonBest === null || Number.isFinite(b.seasonBest))
	)
}

// The legacy server keyed ranked boards by the queue's game mode
// ('ranked:<mode>'); Nakama keys them by the bare mode.
function bareBoard(board: LegacyBoard): LegacyBoard {
	return { ...board, mode: board.mode.replace(/^ranked:/, '') }
}

function recordOf(board: LegacyBoard): RatingRecord {
	return {
		rating: board.rating,
		wins: board.wins,
		losses: board.losses,
		gamesPlayed: board.gamesPlayed,
		seasonBest: board.seasonBest,
		lastMatchAt: board.lastMatchAt,
	}
}

// {players: {<steamIdHash>: {boards: [...]}}} -> {imported, skipped}. Server
// to server only (the http key, no player session). Re-running overwrites a
// player's unclaimed boards and leaves claimed ones alone.
export function rpcLegacyRatingsImport(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	let players: { [hash: string]: { boards?: unknown } }
	try {
		players = JSON.parse(payload).players
	} catch (e) {
		throw runtimeError(INVALID_ARGUMENT, 'Payload must be {players: {<hash>: {boards: []}}}')
	}
	const hashes = Object.keys(players || {})
	if (hashes.length === 0 || hashes.length > IMPORT_BATCH_LIMIT)
		throw runtimeError(INVALID_ARGUMENT, `Send 1 to ${IMPORT_BATCH_LIMIT} players per call`)

	const valid: { hash: string; boards: LegacyBoard[] }[] = []
	let skipped = 0
	for (const hash of hashes) {
		const boards = players[hash].boards
		if (!HASH_PATTERN.test(hash) || !Array.isArray(boards) || !boards.every(isLegacyBoard)) {
			skipped++
			continue
		}
		valid.push({ hash, boards: boards.map(bareBoard) })
	}
	const claimed = new Set(
		nk
			.storageRead(valid.map((p) => ({ collection: LEGACY_RATINGS_COLLECTION, key: p.hash, userId: SYSTEM_USER_ID })))
			.filter((o) => (o.value as unknown as LegacyPlayer).claimedBy)
			.map((o) => o.key),
	)
	const writes = valid
		.filter((p) => !claimed.has(p.hash))
		.map((p) => ({
			collection: LEGACY_RATINGS_COLLECTION,
			key: p.hash,
			userId: SYSTEM_USER_ID,
			value: { boards: p.boards } as unknown as { [key: string]: unknown },
			permissionRead: 0 as const,
			permissionWrite: 0 as const,
		}))
	if (writes.length > 0) nk.storageWrite(writes)
	logger.info('Legacy ratings import: %d written, %d already claimed, %d skipped', writes.length, claimed.size, skipped)
	return JSON.stringify({ imported: writes.length, alreadyClaimed: claimed.size, skipped })
}

// Moves a player's parked ratings onto their account. Boards they already
// have a record for are kept as they are. The records and the claimed marker
// go in one storage write, so a retry can't claim twice.
export function claimLegacyRatings(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	userId: string,
	username: string,
	hash: string,
	now: number,
): number {
	const [parked] = nk.storageRead([{ collection: LEGACY_RATINGS_COLLECTION, key: hash, userId: SYSTEM_USER_ID }])
	const legacy = parked?.value as unknown as LegacyPlayer | undefined
	if (!parked || !legacy || legacy.claimedBy) return 0
	// Parked before the import dropped the prefix.
	const boards = legacy.boards.map(bareBoard)

	const existing = new Set(
		nk
			.storageRead(
				boards.map((b) => ({
					collection: RATINGS_COLLECTION,
					key: boardId(b.modId, b.mode, b.season),
					userId,
				})),
			)
			.map((o) => o.key),
	)
	const fresh = boards.filter((b) => !existing.has(boardId(b.modId, b.mode, b.season)))
	const writes: nkruntime.StorageWriteRequest[] = fresh.map((b) => ({
		collection: RATINGS_COLLECTION,
		key: boardId(b.modId, b.mode, b.season),
		userId,
		value: recordOf(b) as unknown as { [key: string]: unknown },
		permissionRead: 2,
		permissionWrite: 0,
		version: '*',
	}))
	writes.push({
		collection: LEGACY_RATINGS_COLLECTION,
		key: hash,
		userId: SYSTEM_USER_ID,
		value: { ...legacy, claimedBy: userId, claimedAt: now } as unknown as { [key: string]: unknown },
		permissionRead: 0,
		permissionWrite: 0,
		version: parked.version,
	})
	nk.storageWrite(writes)

	for (const b of fresh) {
		if (b.gamesPlayed < PLACEMENT_GAMES) continue
		const id = boardId(b.modId, b.mode, b.season)
		try {
			nk.leaderboardCreate(id, true, 'desc', 'set', null, { modId: b.modId, mode: b.mode })
			nk.leaderboardRecordWrite(id, userId, username, b.rating, b.wins, {
				losses: b.losses,
				gamesPlayed: b.gamesPlayed,
				seasonBest: b.seasonBest,
			}, 'set')
		} catch (e) {
			logger.warn('Legacy rating leaderboard write for %s failed: %v', userId, e)
		}
	}
	logger.info('Claimed %d legacy rating boards for %s', fresh.length, userId)
	return fresh.length
}

// After a Steam login: claim whatever was parked under the player's hash.
// Never fails the login.
export function claimLegacyRatingsAtLogin(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
) {
	try {
		const salt = ctx.env.PLAYER_ID_SALT
		if (!salt || !ctx.userId) return
		const account = nk.accountGetId(ctx.userId)
		if (!account.customId.startsWith(STEAM_CUSTOM_ID_PREFIX)) return
		const hash = steamIdHash(nk, salt, account.customId.slice(STEAM_CUSTOM_ID_PREFIX.length))
		claimLegacyRatings(nk, logger, ctx.userId, account.user.username, hash, Date.now())
	} catch (e) {
		logger.error('Legacy rating claim failed: %v', e)
	}
}

