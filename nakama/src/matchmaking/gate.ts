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
import { groupOf } from './group/binding'
import { blocksSoloQueue } from './group/refusal'
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

export const IN_GROUP_QUEUE = 'You are queueing with your lobby.'

// registerRtBefore('MatchmakerAdd'): a refused ticket fails with the reason.
// A player whose lobby is queueing as a group (matchmaking/group) is queued
// through its party's ticket, not one of their own.
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
	const group = groupOf(nk, ctx.userId)
	if (group && blocksSoloQueue(group.phase)) throw runtimeError(PERMISSION_DENIED, IN_GROUP_QUEUE)
	if (ranked && readConfig(nk).integrityEnforced) checkRankedReadiness(ctx, logger, nk, ctx.userId)
	return envelope
}

// The matched players who may no longer queue.
export function refusedPlayers(nk: nkruntime.Nakama, plan: MatchPlan): string[] {
	const now = Date.now()
	const ranked = plan.rankedMode !== ''
	return plan.playerIds.filter((id) => queueRefusalFor(nk, id, ranked, now) !== null)
}

// A refused match spent everyone's ticket, so the solo players still allowed
// to are told to queue again ({modId, mode} name the queue as the client
// does). A group's members hear it from their lobby instead (matched.ts).
export function requeueSolos(nk: nkruntime.Nakama, plan: MatchPlan, refusedIds: string[]) {
	const mode = plan.rankedMode !== '' ? plan.rankedMode : plan.gameMode
	const grouped = plan.groups.reduce((ids: string[], g) => ids.concat(g.memberIds), [])
	for (const id of plan.playerIds) {
		if (refusedIds.indexOf(id) !== -1 || grouped.indexOf(id) !== -1) continue
		notify(nk, id, NotifyCode.QUEUE_CANCELLED, 'queue_cancelled', {
			modId: plan.modId,
			mode,
			reason: 'A matched player can no longer play',
			requeue: true,
		})
	}
}

// When any matched player may no longer queue, the match is refused and the
// others are told to queue again.
export function refuseMatchedGroup(nk: nkruntime.Nakama, logger: nkruntime.Logger, plan: MatchPlan): boolean {
	const refused = refusedPlayers(nk, plan)
	if (refused.length === 0) return false
	requeueSolos(nk, plan, refused)
	logger.warn('Matched group refused: %d player(s) may not queue', refused.length)
	return true
}
