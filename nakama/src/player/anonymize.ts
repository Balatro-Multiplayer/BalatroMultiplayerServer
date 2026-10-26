// Account deletion (Notice decision 17): before the account goes, every
// system-owned object that names the player is rewritten to name a random
// anonymous id instead, which the API also gives the player's Postgres rows.
// The other players' games stay whole; nothing left links back to the
// account. Objects the player owns go with the account (Nakama deletes them).
import { BINDING_COLLECTION } from '../matchmaking/group/binding'
import {
	LOBBY_CHECKPOINT_COLLECTION,
	LOGS_COLLECTION,
	MY_RUNS_COLLECTION,
	RUNS_COLLECTION,
	type RunRecord,
	SYSTEM_USER_ID,
} from '../lobby/protocol'
import { logKey } from '../lobby/storage'
import { MIRROR_COLLECTION } from '../mirror/outbox'
import { BAN_TYPES, activeBan, readBans } from '../moderation/bans'
import { BAN_INDEX_COLLECTION, loginKeys } from '../moderation/enforce'
import {
	IP_HASHES_COLLECTION,
	IP_HASHES_KEY,
	NETWORK_BANS_COLLECTION,
} from '../moderation/network'
import { LEGACY_RATINGS_COLLECTION, type LegacyPlayer } from '../rating/legacy'
import { steamIdHashOf } from './steam_id'

export const DELETED_PLAYER_NAME = '[deleted player]'
const LIST_PAGE = 100

// value with every string equal to `from`, and every object key equal to it,
// replaced by `to`. Pure.
export function replaceId<T>(value: T, from: string, to: string): T {
	if (value === from) return to as unknown as T
	if (Array.isArray(value))
		return value.map((v) => replaceId(v, from, to)) as unknown as T
	if (value !== null && typeof value === 'object') {
		const next: { [key: string]: unknown } = {}
		for (const key of Object.keys(value))
			next[key === from ? to : key] = replaceId(
				(value as { [key: string]: unknown })[key],
				from,
				to,
			)
		return next as T
	}
	return value
}

// value with the display name dropped wherever it belongs to anonymousId: an
// object naming them by id, senderId, playerId or userId loses its
// displayName (and its info.displayName, as a lobby seat keeps it). Pure.
export function withoutNameOf<T>(value: T, anonymousId: string): T {
	if (Array.isArray(value)) return value.map((v) => withoutNameOf(v, anonymousId)) as unknown as T
	if (value === null || typeof value !== 'object') return value
	const next: { [key: string]: unknown } = {}
	for (const key of Object.keys(value))
		next[key] = withoutNameOf((value as { [key: string]: unknown })[key], anonymousId)
	const theirs = next.id === anonymousId || next.senderId === anonymousId || next.playerId === anonymousId || next.userId === anonymousId
	if (theirs) {
		if (typeof next.displayName === 'string') next.displayName = DELETED_PLAYER_NAME
		const info = next.info as { [key: string]: unknown } | null | undefined
		if (info && typeof info === 'object' && typeof info.displayName === 'string')
			next.info = { ...info, displayName: DELETED_PLAYER_NAME }
	}
	return next as T
}

// The run with the player replaced by anonymousId, their display name dropped.
export function anonymizedRun(
	run: RunRecord,
	userId: string,
	anonymousId: string,
): RunRecord {
	const next = replaceId(run, userId, anonymousId)
	return {
		...next,
		players: next.players.map((p) =>
			p.id === anonymousId ? { ...p, displayName: DELETED_PLAYER_NAME } : p,
		),
	}
}

const SERVER_ONLY = { permissionRead: 0, permissionWrite: 0 } as const

function listAll(
	nk: nkruntime.Nakama,
	owner: string,
	collection: string,
): nkruntime.StorageObject[] {
	const all: nkruntime.StorageObject[] = []
	let cursor = ''
	do {
		const page = nk.storageList(owner, collection, LIST_PAGE, cursor)
		for (const o of page.objects || []) all.push(o)
		cursor = page.cursor || ''
	} while (cursor)
	return all
}

// The player's runs (found by their own run pointers) and each replay log.
function anonymizeRuns(
	nk: nkruntime.Nakama,
	userId: string,
	anonymousId: string,
) {
	for (const pointer of listAll(nk, userId, MY_RUNS_COLLECTION)) {
		const runId = (pointer.value as { runId?: unknown }).runId
		if (typeof runId !== 'string') continue
		const [object] = nk.storageRead([
			{ collection: RUNS_COLLECTION, key: runId, userId: SYSTEM_USER_ID },
		])
		if (!object) continue
		const run = object.value as unknown as RunRecord
		const writes: nkruntime.StorageWriteRequest[] = [
			{
				collection: RUNS_COLLECTION,
				key: runId,
				userId: SYSTEM_USER_ID,
				value: anonymizedRun(run, userId, anonymousId) as unknown as {
					[key: string]: unknown
				},
				permissionRead: 2,
				permissionWrite: 0,
			},
		]
		const [log] = nk.storageRead([
			{
				collection: LOGS_COLLECTION,
				key: logKey(runId, userId),
				userId: SYSTEM_USER_ID,
			},
		])
		if (log)
			writes.push({
				collection: LOGS_COLLECTION,
				key: logKey(runId, anonymousId),
				userId: SYSTEM_USER_ID,
				value: log.value,
				...SERVER_ONLY,
			})
		nk.storageWrite(writes)
		if (log)
			nk.storageDelete([
				{
					collection: LOGS_COLLECTION,
					key: logKey(runId, userId),
					userId: SYSTEM_USER_ID,
				},
			])
	}
}

// Every system-owned object of a collection whose value names the player.
// With dropNames, the player's display names in it go too.
function rewriteSystemObjects(
	nk: nkruntime.Nakama,
	collection: string,
	userId: string,
	anonymousId: string,
	dropNames = false,
) {
	const writes: nkruntime.StorageWriteRequest[] = []
	for (const o of listAll(nk, SYSTEM_USER_ID, collection)) {
		const replaced = replaceId(o.value, userId, anonymousId)
		const next = dropNames ? withoutNameOf(replaced, anonymousId) : replaced
		if (JSON.stringify(next) === JSON.stringify(o.value)) continue
		writes.push({
			collection,
			key: o.key,
			userId: SYSTEM_USER_ID,
			value: next,
			...SERVER_ONLY,
		})
	}
	if (writes.length > 0) nk.storageWrite(writes)
}

// The account-ban index entries for the player's login ids: kept (they
// enforce the ban on a new account), naming the anonymous id.
function anonymizeBanIndex(
	nk: nkruntime.Nakama,
	userId: string,
	anonymousId: string,
) {
	const objects = nk.storageRead(
		loginKeys(nk, userId).map((key) => ({
			collection: BAN_INDEX_COLLECTION,
			key,
			userId: SYSTEM_USER_ID,
		})),
	)
	if (objects.length === 0) return
	nk.storageWrite(
		objects.map((o) => ({
			collection: BAN_INDEX_COLLECTION,
			key: o.key,
			userId: SYSTEM_USER_ID,
			value: replaceId(o.value, userId, anonymousId),
			...SERVER_ONLY,
		})),
	)
}

// The legacy ratings the player claimed (rating/legacy.ts), keyed by their
// Steam id hash. Under the Postgres rule the hash stays only while the player
// is banned, then naming the anonymous id; otherwise the entry goes.
function anonymizeLegacyRatings(
	nk: nkruntime.Nakama,
	userId: string,
	anonymousId: string,
	now: number,
) {
	const hash = steamIdHashOf(nk, userId)
	if (!hash) return
	const [parked] = nk.storageRead([{ collection: LEGACY_RATINGS_COLLECTION, key: hash, userId: SYSTEM_USER_ID }])
	if (!parked || (parked.value as unknown as LegacyPlayer).claimedBy !== userId) return
	const bans = readBans(nk, userId)
	const banned = BAN_TYPES.some((type) => activeBan(bans, type, now) !== null)
	if (!banned) {
		nk.storageDelete([{ collection: LEGACY_RATINGS_COLLECTION, key: hash, userId: SYSTEM_USER_ID }])
		return
	}
	nk.storageWrite([
		{
			collection: LEGACY_RATINGS_COLLECTION,
			key: hash,
			userId: SYSTEM_USER_ID,
			value: { ...parked.value, claimedBy: anonymousId },
			...SERVER_ONLY,
		},
	])
}

// Rewrites everything system-owned that names userId to name anonymousId.
// Call while the account still exists (its login ids and run pointers are
// read from it).
export function anonymizeAccount(
	nk: nkruntime.Nakama,
	userId: string,
	anonymousId: string,
) {
	anonymizeRuns(nk, userId, anonymousId)
	anonymizeLegacyRatings(nk, userId, anonymousId, Date.now())
	rewriteSystemObjects(nk, MIRROR_COLLECTION, userId, anonymousId)
	rewriteSystemObjects(nk, LOBBY_CHECKPOINT_COLLECTION, userId, anonymousId, true)
	rewriteSystemObjects(nk, BINDING_COLLECTION, userId, anonymousId)
	rewriteSystemObjects(nk, NETWORK_BANS_COLLECTION, userId, anonymousId)
	anonymizeBanIndex(nk, userId, anonymousId)
	// A network ban keeps its own copy of the hashes until it is lifted.
	nk.storageDelete([
		{ collection: IP_HASHES_COLLECTION, key: IP_HASHES_KEY, userId },
	])
}
