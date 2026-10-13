// A player whose grace period ran out mid-game in a matchmade lobby is out
// of it: the others' reports place them. If they come back moments later,
// the timeout may have been wrongful (their reconnect lost a race), so a
// moderator gets to look (the API's forfeit_reconciliation_flags, as its
// grace-period.service.ts checkForWrongfulForfeit filed them). The timeout
// is kept on the player; noteReturn, on their next session_init or
// lobby_current, files it through the mirror if they're back in time.
import { enqueue } from '../mirror/outbox'

export const FORFEITS_COLLECTION = 'forfeits'

// How soon after timing out a return counts as "just missed it".
export const RECONCILIATION_WINDOW_MS = 60 * 1000

export interface Forfeit {
	runId: string
	code: string
	at: number
}

export function recordForfeit(nk: nkruntime.Nakama, userId: string, forfeit: Forfeit) {
	nk.storageWrite([
		{
			collection: FORFEITS_COLLECTION,
			key: forfeit.runId,
			userId,
			value: forfeit as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

// Files every timeout the player is back in time for, and forgets them all.
export function noteReturn(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, now: number) {
	try {
		const objects = nk.storageList(userId, FORFEITS_COLLECTION, 10, '').objects || []
		if (objects.length === 0) return
		for (const object of objects) {
			const forfeit = object.value as unknown as Forfeit
			if (now - forfeit.at <= RECONCILIATION_WINDOW_MS)
				enqueue(nk, { kind: 'forfeit', at: now, userId, runId: forfeit.runId, code: forfeit.code, forfeitedAt: forfeit.at })
		}
		nk.storageDelete(objects.map((o) => ({ collection: FORFEITS_COLLECTION, key: o.key, userId })))
	} catch (e) {
		logger.warn('Could not check %s for a wrongful forfeit: %v', userId, e)
	}
}
