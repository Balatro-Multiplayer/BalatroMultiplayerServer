// Where a group queue's party lives: an index from the party (and from each
// member) to the home lobby whose group it is, and the party's own stream.
// The index only says which lobby to ask; the lobby is the truth (its
// group_status), so a stale entry -- a lobby closed or restarted under it --
// reads as no group and is dropped.
import { lookupCode } from '../../lobby/codes'
import { SYSTEM_USER_ID, type GroupQueueView, type LobbySignal } from '../../lobby/protocol'

// partyId -> GroupBinding, owned by the system user.
export const BINDING_COLLECTION = 'group_parties'
// Per member: the party their lobby is queueing with, for the solo gate.
export const MEMBER_COLLECTION = 'group_member'
export const MEMBER_KEY = 'current'
// The realtime stream Nakama keeps a party's members on.
const PARTY_STREAM = 7
// A party ticket the leader took back before its add's after-hook ran.
const REMOVED_PREFIX = 'removed:'

export interface GroupBinding {
	partyId: string
	homeCode: string
	modId: string
	memberIds: string[]
}

function bindingKey(partyId: string) {
	return { collection: BINDING_COLLECTION, key: partyId, userId: SYSTEM_USER_ID }
}

function memberKey(userId: string) {
	return { collection: MEMBER_COLLECTION, key: MEMBER_KEY, userId }
}

export function writeBinding(nk: nkruntime.Nakama, binding: GroupBinding) {
	const write = (
		key: { collection: string; key: string; userId: string },
		value: { [key: string]: unknown },
	): nkruntime.StorageWriteRequest => ({ ...key, value, permissionRead: 0, permissionWrite: 0 })
	nk.storageWrite(
		[write(bindingKey(binding.partyId), { ...binding })].concat(
			binding.memberIds.map((id) => write(memberKey(id), { partyId: binding.partyId, homeCode: binding.homeCode })),
		),
	)
}

export function readBinding(nk: nkruntime.Nakama, partyId: string): GroupBinding | null {
	const objects = nk.storageRead([bindingKey(partyId)])
	return objects.length > 0 ? (objects[0].value as unknown as GroupBinding) : null
}

// Drops the binding, and each member's pointer that still names this party.
export function deleteBinding(nk: nkruntime.Nakama, partyId: string, memberIds: string[]) {
	const pointers = nk.storageRead(memberIds.map(memberKey)).filter((o) => o.value.partyId === partyId)
	nk.storageDelete([bindingKey(partyId)].concat(pointers.map((o) => memberKey(o.userId))))
}

// Signals the live lobby behind a home code; null when there is none.
export function signalHome(nk: nkruntime.Nakama, homeCode: string, signal: LobbySignal): string | null {
	const entry = lookupCode(nk, homeCode)
	if (!entry) return null
	return nk.matchSignal(entry.matchId, JSON.stringify(signal))
}

// The home lobby's view of the party's group queue, or null when no live
// lobby is queueing with it.
export function statusOf(nk: nkruntime.Nakama, partyId: string): { status: GroupQueueView; binding: GroupBinding } | null {
	const binding = readBinding(nk, partyId)
	if (!binding) return null
	const reply = signalHome(nk, binding.homeCode, { type: 'group_status', partyId })
	const status = reply ? (JSON.parse(reply) as GroupQueueView | null) : null
	if (!status) {
		deleteBinding(nk, partyId, binding.memberIds)
		return null
	}
	return { status, binding }
}

// The group queue userId's lobby has them in, or null.
export function groupOf(nk: nkruntime.Nakama, userId: string): GroupQueueView | null {
	const objects = nk.storageRead([memberKey(userId)])
	if (objects.length === 0) return null
	const found = statusOf(nk, String(objects[0].value.partyId))
	if (!found || found.status.memberIds.indexOf(userId) === -1) {
		nk.storageDelete([memberKey(userId)])
		return null
	}
	return found.status
}

// Nakama names a party "<uuid>.<node>"; its stream is keyed by both halves.
function partyStream(partyId: string) {
	const dot = partyId.indexOf('.')
	return { mode: PARTY_STREAM, subject: partyId.slice(0, dot), label: partyId.slice(dot + 1) }
}

export function partyPresences(nk: nkruntime.Nakama, partyId: string): nkruntime.Presence[] {
	if (partyId.indexOf('.') === -1) return []
	return nk.streamUserList(partyStream(partyId), true, true)
}

// Takes everyone out of the party, which ends it and drops its tickets. The
// members aren't told by Nakama: their lobby's GROUP_QUEUE op says why.
export function dissolveParty(nk: nkruntime.Nakama, partyId: string) {
	const stream = partyStream(partyId)
	// streamUserList names the node nodeId; the party's members are on the
	// party's own node.
	for (const p of partyPresences(nk, partyId)) {
		const node = p.node || (p as unknown as { nodeId?: string }).nodeId || stream.label
		nk.streamUserKick({ userId: p.userId, sessionId: p.sessionId, node }, stream)
	}
}

// A remove that came before its ticket's add after-hook leaves this, so the
// after-hook doesn't mark the group queued on a ticket already gone.
export function markTicketRemoved(nk: nkruntime.Nakama, ticket: string) {
	nk.storageWrite([
		{
			collection: BINDING_COLLECTION,
			key: REMOVED_PREFIX + ticket,
			userId: SYSTEM_USER_ID,
			value: { at: Date.now() },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

// Whether the ticket was marked removed (and the mark is dropped).
export function takeTicketRemoved(nk: nkruntime.Nakama, ticket: string): boolean {
	const key = { collection: BINDING_COLLECTION, key: REMOVED_PREFIX + ticket, userId: SYSTEM_USER_ID }
	if (nk.storageRead([key]).length === 0) return false
	nk.storageDelete([key])
	return true
}
