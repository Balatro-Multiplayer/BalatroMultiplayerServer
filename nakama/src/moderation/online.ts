// Whether the player has a socket open, so a Notification pushed now reaches
// them. A failed lookup counts as offline: a ban then waits for their next
// session start, which is the safe side for the player.
const NOTIFICATIONS_STREAM = 0

export function isOnline(nk: nkruntime.Nakama, userId: string): boolean {
	try {
		return nk.streamUserList({ mode: NOTIFICATIONS_STREAM, subject: userId }, true, true).length > 0
	} catch (e) {
		return false
	}
}
