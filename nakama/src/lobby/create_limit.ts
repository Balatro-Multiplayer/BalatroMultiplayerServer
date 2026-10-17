// A per-player limit on lobby_create. A created lobby runs its match for up to
// CREATOR_JOIN_TIMEOUT_MS even if nobody joins, and the creator only counts as
// in it once joined (so "Already in lobby" doesn't stop a second create):
// without a limit one client could keep hundreds of lobby matches running.
// Generous for people and for test suites that create a lobby per test.
export const CREATE_LIMIT = 30
export const CREATE_WINDOW_MS = 60_000
const LIMIT_COLLECTION = 'limits'
const LIMIT_KEY = 'lobby_create_times'

// Pure: the player's recent creation times still in the window plus `now`, or
// null when one more now would go over the limit.
export function createTimesAfter(
	times: number[],
	now: number,
): number[] | null {
	const recent = times.filter((t) => now - t < CREATE_WINDOW_MS)
	if (recent.length >= CREATE_LIMIT) return null
	return recent.concat([now])
}

function readTimes(nk: nkruntime.Nakama, userId: string): number[] {
	const objects = nk.storageRead([
		{ collection: LIMIT_COLLECTION, key: LIMIT_KEY, userId },
	])
	const times = objects.length > 0 ? objects[0].value.times : null
	return Array.isArray(times) ? times.filter((t) => typeof t === 'number') : []
}

// Records one creation now; false (nothing written) when it is over the limit.
export function spendLobbyCreate(
	nk: nkruntime.Nakama,
	userId: string,
	now: number,
): boolean {
	const times = createTimesAfter(readTimes(nk, userId), now)
	if (!times) return false
	nk.storageWrite([
		{
			collection: LIMIT_COLLECTION,
			key: LIMIT_KEY,
			userId,
			value: { times },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
	return true
}
