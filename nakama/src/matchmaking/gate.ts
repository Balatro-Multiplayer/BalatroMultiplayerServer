// Who may queue: the server switches (ranked/casual queues, testing mode)
// queue bans (moderation/access.ts) and, for ranked, launcher integrity
// (integrity.ts), checked when a ticket is added and
// again when a group is matched (a ban or switch can land in between).
import { readConfig } from '../config'
import { checkRankedReadiness, integrityRefusal, readIntegrity } from '../integrity'
import { PERMISSION_DENIED, runtimeError } from '../errors'
import { queueRefusal } from '../moderation/access'
import { readBans } from '../moderation/bans'
import { notify, NotifyCode } from '../notify'
import { profileFor } from '../player/profile'
import type { MatchPlan } from './matched'

export function queueRefusalFor(nk: nkruntime.Nakama, userId: string, ranked: boolean, now: number): string | null {
	const config = readConfig(nk)
	const refused = queueRefusal(config, profileFor(nk, userId).privileges, readBans(nk, userId), ranked, now)
	if (refused || !ranked) return refused
	return integrityRefusal(config, readIntegrity(nk, userId), now)
}

function stringProperties(envelope: nkruntime.Envelope): { [key: string]: unknown } {
	const add = (envelope.matchmakerAdd || envelope.matchmaker_add) as { [key: string]: unknown } | undefined
	return ((add && (add.stringProperties || add.string_properties)) as { [key: string]: unknown }) || {}
}

// registerRtBefore('MatchmakerAdd'): a refused ticket fails with the reason.
export function beforeMatchmakerAdd(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	envelope: nkruntime.Envelope,
): nkruntime.Envelope {
	if (!ctx.userId) return envelope
	const ranked = stringProperties(envelope).kind === 'ranked'
	const refused = queueRefusalFor(nk, ctx.userId, ranked, Date.now())
	if (refused) throw runtimeError(PERMISSION_DENIED, refused)
	if (ranked && readConfig(nk).integrityEnforced) checkRankedReadiness(ctx, logger, nk, ctx.userId)
	return envelope
}

// The matched players who may no longer queue. When there are any, the
// group is refused; the matchmaker has spent everyone's ticket, so the others
// are told to queue again ({modId, mode} name the queue as the client does).
export function refuseMatchedGroup(nk: nkruntime.Nakama, logger: nkruntime.Logger, plan: MatchPlan): boolean {
	const now = Date.now()
	const ranked = plan.rankedMode !== ''
	const refused = plan.playerIds.filter((id) => queueRefusalFor(nk, id, ranked, now) !== null)
	if (refused.length === 0) return false
	const mode = ranked ? plan.rankedMode : plan.gameMode
	for (const id of plan.playerIds) {
		if (refused.indexOf(id) !== -1) continue
		notify(nk, id, NotifyCode.QUEUE_CANCELLED, 'queue_cancelled', {
			modId: plan.modId,
			mode,
			reason: 'A matched player can no longer play',
			requeue: true,
		})
	}
	logger.warn('Matched group refused: %d player(s) may not queue', refused.length)
	return true
}
