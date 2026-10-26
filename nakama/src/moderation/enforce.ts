// Putting bans into force. The API issues and lifts them (admin_ban_apply /
// admin_ban_lift) and Postgres keeps their history; here a ban reaches the
// player at once:
// - account: Nakama's own ban (usersBanId: sessions dropped, logins and
//   refreshes refused), the player taken out of their lobby, BANNED pushed.
// - queue: out of a started game (an instant forfeit, as the API's
//   forfeitMatchForBan), and refused at MatchmakerAdd.
// - chat: refused at chat_send.
//
// usersBanId has no expiry, so a temporary account ban is lifted lazily: the
// login before-hooks look the account up in ban_index (Steam id or device id
// -> ban) and unban an expired one before Nakama's own check runs.
import { runtimeError, PERMISSION_DENIED } from '../errors'
import { currentLobby } from '../lobby/rpc'
import { SYSTEM_USER_ID, type LobbySignal } from '../lobby/protocol'
import { notify, NotifyCode } from '../notify'
import { ACCOUNT_BANNED, banMessage } from './access'
import {
	activeBan,
	readBans,
	withBan,
	withoutBan,
	withoutExpired,
	writeBans,
	type Ban,
	type BanType,
	type Bans,
} from './bans'

export const BAN_INDEX_COLLECTION = 'ban_index'

interface IndexEntry {
	userId: string
	ban: Ban
}

// The login ids that lead to userId's account: its Steam custom id and any
// device ids, as the before-hooks see them.
export function loginKeys(nk: nkruntime.Nakama, userId: string): string[] {
	const account = nk.accountGetId(userId)
	const keys: string[] = []
	if (account.customId) keys.push('custom:' + account.customId)
	for (const device of account.devices || []) keys.push('device:' + device.id)
	return keys
}

function writeIndex(nk: nkruntime.Nakama, userId: string, ban: Ban) {
	const value: IndexEntry = { userId, ban }
	nk.storageWrite(
		loginKeys(nk, userId).map((key) => ({
			collection: BAN_INDEX_COLLECTION,
			key,
			userId: SYSTEM_USER_ID,
			value: value as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
		})),
	)
}

function deleteIndex(nk: nkruntime.Nakama, userId: string) {
	nk.storageDelete(
		loginKeys(nk, userId).map((key) => ({ collection: BAN_INDEX_COLLECTION, key, userId: SYSTEM_USER_ID })),
	)
}

// Takes userId out of their lobby: always for an account ban, only out of a
// running game for a queue ban.
function removeFromLobby(nk: nkruntime.Nakama, userId: string, reason: string, onlyIfStarted: boolean) {
	const lobby = currentLobby(nk, userId)
	if (!lobby) return
	const signal: LobbySignal = { type: 'admin_remove', userId, reason, onlyIfStarted }
	nk.matchSignal(lobby.matchId, JSON.stringify(signal))
}

function pushBan(nk: nkruntime.Nakama, userId: string, type: BanType, ban: Ban) {
	notify(
		nk,
		userId,
		NotifyCode.BANNED,
		'banned',
		{ banType: type, banId: ban.banId, reason: ban.reason, expiresAt: ban.expiresAt },
		type === 'account',
	)
}

// Account-ban side effects for a ban already in storage.
export function enforceAccountBan(nk: nkruntime.Nakama, userId: string, ban: Ban) {
	writeIndex(nk, userId, ban)
	removeFromLobby(nk, userId, 'banned', false)
	nk.usersBanId([userId])
}

export function applyBan(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	userId: string,
	type: BanType,
	ban: Ban,
): Bans {
	const bans = withBan(readBans(nk, userId), type, ban)
	writeBans(nk, userId, bans)
	pushBan(nk, userId, type, ban)
	if (type === 'queue') removeFromLobby(nk, userId, 'banned', true)
	if (type === 'account' && bans.account) enforceAccountBan(nk, userId, bans.account)
	logger.info('Applied %s ban %s to %s', type, ban.banId, userId)
	return bans
}

// Lifts Nakama's own ban once no account ban is left.
function releaseAccount(nk: nkruntime.Nakama, userId: string, before: Bans, after: Bans) {
	if (before.account && !after.account) {
		deleteIndex(nk, userId)
		nk.usersUnbanId([userId])
	}
}

export function liftBan(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, banId: string): Bans {
	const before = readBans(nk, userId)
	const after = withoutBan(before, banId)
	writeBans(nk, userId, after)
	releaseAccount(nk, userId, before, after)
	logger.info('Lifted ban %s of %s', banId, userId)
	return after
}

// Re-keys an account's ban index entry after its login id changed (a Device
// login moving from the raw Steam id to its hash), so the old id is not kept.
export function moveLoginKey(nk: nkruntime.Nakama, from: string, to: string) {
	const [entry] = nk.storageRead([{ collection: BAN_INDEX_COLLECTION, key: from, userId: SYSTEM_USER_ID }])
	if (!entry) return
	nk.storageWrite([
		{
			collection: BAN_INDEX_COLLECTION,
			key: to,
			userId: SYSTEM_USER_ID,
			value: entry.value,
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
	nk.storageDelete([{ collection: BAN_INDEX_COLLECTION, key: from, userId: SYSTEM_USER_ID }])
}

// For the login before-hooks: refuses a login into a banned account, and
// lifts an account ban that has run out. key is a loginKeys entry.
export function checkLoginBan(nk: nkruntime.Nakama, logger: nkruntime.Logger, key: string, now: number) {
	const objects = nk.storageRead([{ collection: BAN_INDEX_COLLECTION, key, userId: SYSTEM_USER_ID }])
	if (objects.length === 0) return
	const entry = objects[0].value as unknown as IndexEntry
	if (activeBan({ account: entry.ban }, 'account', now))
		throw runtimeError(PERMISSION_DENIED, banMessage(ACCOUNT_BANNED, entry.ban))
	const before = readBans(nk, entry.userId)
	const after = withoutExpired(before, now)
	if (after !== before) writeBans(nk, entry.userId, after)
	if (activeBan(after, 'account', now)) {
		// A longer ban replaced the indexed one; index it instead.
		writeIndex(nk, entry.userId, after.account as Ban)
		throw runtimeError(PERMISSION_DENIED, banMessage(ACCOUNT_BANNED, after.account as Ban))
	}
	deleteIndex(nk, entry.userId)
	nk.usersUnbanId([entry.userId])
	logger.info('Account ban of %s expired; unbanned', entry.userId)
}
