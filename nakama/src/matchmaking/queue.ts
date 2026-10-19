// Live "N queued / M in game" counts per queue, as the API's GET
// /stats/queue-counts answered: {modId, gameModes: {[gameMode]: {queued,
// inMatch}}}, a queue with neither left out.
//
// The JS runtime can't read the matchmaker's tickets, so the module keeps its
// own record of them: one queue_presence object per player and queue, written
// once a MatchmakerAdd is accepted and deleted when the ticket goes
// (MatchmakerRemove, a match being made). A ticket also goes when its session
// disconnects, which the JS runtime has no event for: counting skips (and
// deletes) records whose session is no longer connected. In-match counts come
// from the labels of the lobbies the matchmaker made.
import { INVALID_ARGUMENT, runtimeError } from '../errors'
import { parsePayload } from '../rpc'
import { queueKey } from './matched'

export const QUEUE_COLLECTION = 'queue_presence'
// A record this old is no longer counted, whatever its session.
export const QUEUE_STALE_MS = 30 * 60_000
const LIST_PAGE = 100
const MATCH_LIST_LIMIT = 100
const NOTIFICATIONS_STREAM = 0
const TOMBSTONE_MS = 60_000
const MOD_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

export interface QueueRecord {
	modId: string
	gameMode: string
	ticket: string
	// The session that holds the ticket.
	sessionId: string
	at: number
}

export interface QueueCounts {
	modId: string
	gameModes: { [gameMode: string]: { queued: number; inMatch: number } }
}

// The storage key of a player's record for a queue: one per queue, so
// queueing again for the same one replaces it.
export function recordKey(modId: string, gameMode: string): string {
	return modId + ':' + gameMode
}

// A field of a realtime envelope. The runtime passes the protobuf's JSON
// names (camelCase); snake_case is accepted too.
function field(obj: unknown, camel: string, snake: string): any {
	if (!obj || typeof obj !== 'object') return undefined
	const o = obj as { [key: string]: unknown }
	return o[camel] !== undefined ? o[camel] : o[snake]
}

// What an accepted MatchmakerAdd queued for, or null when its properties
// don't name a queue.
export function recordOf(
	input: unknown,
	output: unknown,
	sessionId: string,
	now: number,
): QueueRecord | null {
	const add = field(input, 'matchmakerAdd', 'matchmaker_add')
	const props = field(add, 'stringProperties', 'string_properties') || {}
	const ticket = field(field(output, 'matchmakerTicket', 'matchmaker_ticket'), 'ticket', 'ticket')
	const modId = props.modId
	const mode = props.mode
	if (typeof ticket !== 'string' || typeof modId !== 'string' || typeof mode !== 'string') return null
	if (!MOD_ID_PATTERN.test(modId) || !MOD_ID_PATTERN.test(mode)) return null
	const gameMode = queueKey(mode, props.kind === 'ranked' ? 'ranked' : 'casual')
	return { modId, gameMode, ticket, sessionId, at: now }
}

// Pure: the counts for modId from the live queue records and the lobbies'
// labels.
export function countQueues(
	modId: string,
	records: QueueRecord[],
	labels: string[],
	now: number,
): QueueCounts {
	const gameModes: QueueCounts['gameModes'] = {}
	const entry = (mode: string) => (gameModes[mode] = gameModes[mode] || { queued: 0, inMatch: 0 })
	for (const r of records) {
		if (r.modId !== modId || now - r.at > QUEUE_STALE_MS) continue
		entry(r.gameMode).queued++
	}
	for (const raw of labels) {
		let label: any
		try {
			label = JSON.parse(raw)
		} catch (e) {
			continue
		}
		if (!label || label.modId !== modId || label.type !== 'public' || !label.mode || !(label.size > 0)) continue
		entry(label.mode).inMatch += label.size
	}
	return { modId, gameModes }
}

function deleteRecords(nk: nkruntime.Nakama, userId: string, keys: string[]) {
	if (keys.length === 0) return
	nk.storageDelete(keys.map((key) => ({ collection: QUEUE_COLLECTION, key, userId })))
}

function ownRecords(nk: nkruntime.Nakama, userId: string): nkruntime.StorageObject[] {
	const out: nkruntime.StorageObject[] = []
	let cursor = ''
	do {
		const page = nk.storageList(userId, QUEUE_COLLECTION, LIST_PAGE, cursor)
		for (const o of page.objects || []) out.push(o)
		cursor = page.cursor || ''
	} while (cursor)
	return out
}

// A remove that came before its ticket's record (see afterMatchmakerAdd)
// leaves this, so the record is never written.
const REMOVED_PREFIX = 'removed:'

function isRecord(o: nkruntime.StorageObject): boolean {
	return o.key.indexOf(REMOVED_PREFIX) !== 0
}

// registerRtAfter('MatchmakerAdd'): the ticket was accepted. After hooks run
// asynchronously, once the client already has its ticket, so the client may
// have removed it by now.
export function afterMatchmakerAdd(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	output: nkruntime.Envelope | null,
	input: nkruntime.Envelope,
) {
	if (!ctx.userId) return
	const record = recordOf(input, output, ctx.sessionId || '', Date.now())
	if (!record) return
	const tombstone = REMOVED_PREFIX + record.ticket
	const removed = nk.storageRead([{ collection: QUEUE_COLLECTION, key: tombstone, userId: ctx.userId }])
	if (removed.length > 0) {
		deleteRecords(nk, ctx.userId, [tombstone])
		return
	}
	nk.storageWrite([
		{
			collection: QUEUE_COLLECTION,
			key: recordKey(record.modId, record.gameMode),
			userId: ctx.userId,
			value: { ...record },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

// registerRtBefore('MatchmakerRemove'): drops the ticket's record (or, when
// it isn't written yet, leaves a tombstone for it) and lets the message
// through.
export function beforeMatchmakerRemove(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	envelope: nkruntime.Envelope,
): nkruntime.Envelope {
	const ticket = field(field(envelope, 'matchmakerRemove', 'matchmaker_remove'), 'ticket', 'ticket')
	if (!ctx.userId || typeof ticket !== 'string' || !ticket) return envelope
	const keys = ownRecords(nk, ctx.userId)
		.filter((o) => isRecord(o) && o.value.ticket === ticket)
		.map((o) => o.key)
	if (keys.length > 0) {
		deleteRecords(nk, ctx.userId, keys)
	} else {
		nk.storageWrite([
			{
				collection: QUEUE_COLLECTION,
				key: REMOVED_PREFIX + ticket,
				userId: ctx.userId,
				value: { at: Date.now() },
				permissionRead: 0,
				permissionWrite: 0,
			},
		])
	}
	return envelope
}

// A made match took each player's ticket for its queue.
export function clearMatched(
	nk: nkruntime.Nakama,
	modId: string,
	gameMode: string,
	userIds: string[],
) {
	for (const userId of userIds) deleteRecords(nk, userId, [recordKey(modId, gameMode)])
}

// A group's party ticket (matchmaking/group/hooks.ts): one record per
// member, under the session the member is in the party with, so Find Game
// counts them as queued.
export function writeGroupRecords(
	nk: nkruntime.Nakama,
	record: Omit<QueueRecord, 'sessionId'>,
	members: { userId: string; sessionId: string }[],
) {
	if (members.length === 0) return
	nk.storageWrite(
		members.map((m) => ({
			collection: QUEUE_COLLECTION,
			key: recordKey(record.modId, record.gameMode),
			userId: m.userId,
			value: { ...record, sessionId: m.sessionId },
			permissionRead: 0,
			permissionWrite: 0,
		})),
	)
}

function sessionsOf(nk: nkruntime.Nakama, userId: string): string[] {
	return nk.streamUserList({ mode: NOTIFICATIONS_STREAM, subject: userId }, true, true).map((p) => p.sessionId)
}

// Which of userIds hold a live ticket (a fresh record whose session is still
// connected) other than exceptTicket.
export function liveTicketHolders(
	nk: nkruntime.Nakama,
	userIds: string[],
	exceptTicket: string | null,
	now: number,
): string[] {
	return userIds.filter((userId) => {
		const records = ownRecords(nk, userId)
			.filter(isRecord)
			.map((o) => o.value as unknown as QueueRecord)
			.filter((r) => r.ticket !== exceptTicket && now - r.at <= QUEUE_STALE_MS)
		if (records.length === 0) return false
		const sessions = sessionsOf(nk, userId)
		return records.some((r) => sessions.indexOf(r.sessionId) !== -1)
	})
}

// The mod's records whose session is still connected (Nakama keeps every
// connected session on the user's notifications stream); the rest are
// deleted.
export function liveRecords(nk: nkruntime.Nakama, modId: string, now: number): QueueRecord[] {
	const byUser: { [userId: string]: nkruntime.StorageObject[] } = {}
	let cursor = ''
	do {
		const page = nk.storageList(null, QUEUE_COLLECTION, LIST_PAGE, cursor)
		for (const o of page.objects || []) {
			if (!isRecord(o)) {
				// Its add hook has long run (or never will: the ticket was
				// already gone).
				if (now - Number(o.value.at) > TOMBSTONE_MS) deleteRecords(nk, o.userId, [o.key])
				continue
			}
			if ((o.value as unknown as QueueRecord).modId !== modId) continue
			;(byUser[o.userId] = byUser[o.userId] || []).push(o)
		}
		cursor = page.cursor || ''
	} while (cursor)
	const live: QueueRecord[] = []
	for (const userId in byUser) {
		const sessions = sessionsOf(nk, userId)
		const dead: string[] = []
		for (const o of byUser[userId]) {
			const record = o.value as unknown as QueueRecord
			if (sessions.indexOf(record.sessionId) === -1) dead.push(o.key)
			else live.push(record)
		}
		deleteRecords(nk, userId, dead)
	}
	return live
}

// {modId} -> {modId, gameModes}. In-match counts cover the first 100 of the
// mod's matchmade lobbies.
export function rpcQueueCounts(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const modId = parsePayload(payload).modId
	if (typeof modId !== 'string' || !MOD_ID_PATTERN.test(modId))
		throw runtimeError(INVALID_ARGUMENT, 'Missing or invalid modId')
	const query = '+label.modId:' + modId.replace(/[^A-Za-z0-9_]/g, '\\$&') + ' +label.type:public'
	const labels = nk
		.matchList(MATCH_LIST_LIMIT, true, null, 1, null, query)
		.map((m) => m.label || '')
	return JSON.stringify(countQueues(modId, liveRecords(nk, modId, Date.now()), labels, Date.now()))
}
