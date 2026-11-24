// The instant queue ranges a ranked queue has (set on the website, pushed in
// the server config). The mod reads its queue's range here when it queues and
// builds its own tickets from it (BalatroMultiplayerAPI api/matchmaking), so
// the range itself decides nothing on the server; the one thing the server
// does is to stamp every ranked ticket with the player's real stored rating
// (stampRating), so a ticket can't claim a rating that puts it in a range.
import { type InstantRange, type ServerConfig, readConfig } from '../config'
import { INVALID_ARGUMENT, UNAUTHENTICATED, runtimeError } from '../errors'
import { loadRatings, newRating } from '../rating/apply'
import { currentSeason } from '../rating/season'
import { parsePayload } from '../rpc'

const QUEUE_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export const NO_RANGE: InstantRange = {
	floor: null,
	ceiling: null,
	floorMultiplier: 1,
	ceilingMultiplier: 1,
}

// The queue's range, or NO_RANGE.
export function rangeFor(
	config: ServerConfig,
	modId: string,
	mode: string,
): InstantRange {
	return config.instantQueue[modId + ':' + mode] || NO_RANGE
}

// {modId, mode} -> {floor, ceiling, floorMultiplier, ceilingMultiplier}.
export function rpcQueueRanges(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	if (!ctx.userId)
		throw runtimeError(UNAUTHENTICATED, 'Queue ranges need a player session')
	const { modId, mode } = parsePayload(payload)
	if (
		typeof modId !== 'string' ||
		typeof mode !== 'string' ||
		!QUEUE_NAME_PATTERN.test(modId) ||
		!QUEUE_NAME_PATTERN.test(mode)
	)
		throw runtimeError(INVALID_ARGUMENT, 'modId and mode are required')
	return JSON.stringify(rangeFor(readConfig(nk), modId, mode))
}

// A ranked ticket's own rating, replaced by the player's stored one (decayed
// as rating_get reads it): the ratings a ticket asks others for are the mod's,
// but the one it offers is the server's.
export function stampRating(
	nk: nkruntime.Nakama,
	userId: string,
	add: { [key: string]: unknown },
	modId: string,
	mode: string,
): void {
	const stored = loadRatings(
		nk,
		modId,
		mode,
		[userId],
		Date.now(),
		currentSeason(nk),
	).current[userId]
	const rating = Math.round((stored || newRating()).rating)
	const numeric = (add.numericProperties || add.numeric_properties) as
		| { [key: string]: unknown }
		| undefined
	if (numeric && typeof numeric === 'object') numeric.rating = rating
	else add.numericProperties = { rating }
}
