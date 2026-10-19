// A matched game's groups: each party's home lobby must still be queueing it,
// for this game, with exactly these members; the home is told when its group
// is matched, queues again, or is let go.
import type { GroupEndReason, GroupQueueView, LobbySignal, MatchedGroup } from '../../lobby/protocol'
import { queueKey, type MatchPlan, type PlannedGroup } from '../matched'
import { clearMatched } from '../queue'
import { readBinding, signalHome, statusOf, type GroupBinding } from './binding'

function sameMembers(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id) => b.indexOf(id) !== -1)
}

// Whether the home's view of its group queue fits the group the matchmaker
// matched (a stale or hand-built party ticket doesn't).
export function groupFits(
	status: GroupQueueView | null,
	group: PlannedGroup,
	plan: { modId: string; gameMode: string },
): boolean {
	return (
		status !== null &&
		status.phase === 'queued' &&
		status.modId === plan.modId &&
		queueKey(status.mode, 'casual') === plan.gameMode &&
		sameMembers(status.memberIds, group.memberIds)
	)
}

export interface ResolvedGroups {
	// Groups whose home is queueing them for this game.
	homes: MatchedGroup[]
	// Groups that don't fit: their party ids, with the binding when there is one.
	faulty: { partyId: string; binding: GroupBinding | null }[]
}

export function resolveGroups(nk: nkruntime.Nakama, plan: MatchPlan): ResolvedGroups {
	const resolved: ResolvedGroups = { homes: [], faulty: [] }
	for (const group of plan.groups) {
		const found = statusOf(nk, group.partyId)
		if (found && groupFits(found.status, group, plan))
			resolved.homes.push({ partyId: group.partyId, homeCode: found.binding.homeCode, memberIds: group.memberIds })
		else resolved.faulty.push({ partyId: group.partyId, binding: found ? found.binding : null })
	}
	return resolved
}

function tell(nk: nkruntime.Nakama, homeCode: string, signal: LobbySignal) {
	signalHome(nk, homeCode, signal)
}

// The matchmaker spent the group's ticket on a game that was refused: the
// home queues again (its host re-adds the ticket).
export function requeueGroup(nk: nkruntime.Nakama, home: MatchedGroup) {
	tell(nk, home.homeCode, { type: 'group_requeue', partyId: home.partyId })
}

export function cancelGroupFor(nk: nkruntime.Nakama, homeCode: string, partyId: string, reason: GroupEndReason) {
	tell(nk, homeCode, { type: 'group_cancel', partyId, reason })
}

export function announceMatched(nk: nkruntime.Nakama, home: MatchedGroup, matchId: string, code: string) {
	tell(nk, home.homeCode, { type: 'group_matched', partyId: home.partyId, matchId, code })
}

// A match that couldn't even be planned: each party in it that a lobby is
// queueing with queues again, and its members' records go.
export function requeuePartiesOf(nk: nkruntime.Nakama, partyIds: string[]) {
	for (const partyId of partyIds) {
		const binding = readBinding(nk, partyId)
		if (!binding) continue
		const found = statusOf(nk, partyId)
		if (!found || found.status.phase !== 'queued') continue
		clearMatched(nk, binding.modId, queueKey(found.status.mode, 'casual'), found.status.memberIds)
		requeueGroup(nk, { partyId, homeCode: binding.homeCode, memberIds: found.status.memberIds })
	}
}
