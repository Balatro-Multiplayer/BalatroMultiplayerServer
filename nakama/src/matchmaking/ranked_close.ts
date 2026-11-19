// Server-only RPCs for closing Ranked before a deploy: cancel every ranked
// queue ticket, and count the ranked matches still running.
import { parsePayload, requireServer } from '../rpc'
import { notify, NotifyCode } from '../notify'
import { clearMatched, liveQueuedPlayers } from './queue'

const RANKED_PREFIX = 'ranked:'
const DEFAULT_REASON = 'Ranked is closed for a server update'
// Far above any real count; one call, so the count is not cut at 100.
const MATCH_LIST_LIMIT = 10000

// {reason?} -> {cancelled}: every player with a ranked ticket is told the
// queue is cancelled (the JS runtime can't remove a ticket, the client leaves
// it on this notice, as for admin_queue_cancel) and the ticket record goes.
// Casual tickets stay.
export function rpcAdminRankedQueueCancel(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const input = parsePayload(payload)
	const reason = typeof input.reason === 'string' && input.reason ? input.reason : DEFAULT_REASON
	let cancelled = 0
	for (const { userId, record } of liveQueuedPlayers(nk, null, Date.now())) {
		if (record.gameMode.indexOf(RANKED_PREFIX) !== 0) continue
		notify(nk, userId, NotifyCode.QUEUE_CANCELLED, 'queue_cancelled', {
			modId: record.modId,
			mode: record.gameMode.slice(RANKED_PREFIX.length),
			reason,
			requeue: false,
		})
		clearMatched(nk, record.modId, record.gameMode, [userId])
		cancelled++
	}
	logger.info('Ranked queue cancelled: %d ticket(s)', cancelled)
	return JSON.stringify({ cancelled })
}

// {} -> {running}: matches that have started and play a ranked mode (the
// label's mode is 'ranked:<mode>').
export function rpcAdminRankedLive(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	let running = 0
	for (const m of nk.matchList(MATCH_LIST_LIMIT, true, null, null, null, '+label.started:T')) {
		try {
			const label = JSON.parse(m.label || '{}')
			if (label.started === true && typeof label.mode === 'string' && label.mode.indexOf(RANKED_PREFIX) === 0) running++
		} catch (e) {
			// An unlabelled match is not a ranked game.
		}
	}
	return JSON.stringify({ running })
}
