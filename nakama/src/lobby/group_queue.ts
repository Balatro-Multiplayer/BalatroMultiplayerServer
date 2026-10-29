// A private lobby queueing as one group (matchmaking/group), as pure
// transitions over the home lobby. The lobby is the group's source of truth:
// the party only carries the ticket, so the hooks and the matcher ask the
// lobby (group_status) and tell it (group_queued, group_matched, ...).
//
//   idle --open--> forming --ticket--> queued --matched--> away --over--> idle
//                     ^                  |
//                     +--removed/requeue-+
//
// Forming and queued end (back to idle) once anyone leaves, is kicked or
// disconnects. Away, the members play the public game the matchmaker found:
// their seats here are parked (no host transfer, no closing, no grace
// running out) until that game is over, everyone is back, or the cap.
import {
	homeRefusal,
	type GroupHomeFacts,
	type GroupRefusal,
	type GroupSwitches,
} from '../matchmaking/group/refusal'
import { err, ok, type Result } from '../shared/result'
import {
	ServerOp,
	type GroupEndReason,
	type GroupQueueMessage,
	type GroupQueueView,
	type MatchedGroup,
	type RefusedMember,
} from './protocol'
import type { Lobby, Outbound, Step } from './state'

// The longest a group's seats stay parked while it is away.
export const GROUP_AWAY_CAP_MS = 90 * 60_000

interface GroupBase {
	partyId: string
	mode: string
	teams: boolean
	// The lobby's players when the queue opened; the group is all of them.
	memberIds: string[]
	since: number
}

export type GroupQueue =
	| (GroupBase & { phase: 'forming' })
	| (GroupBase & { phase: 'queued'; ticket: string })
	| (GroupBase & { phase: 'away'; matchId: string; code: string; until: number })

// The effects a group queue has outside the lobby (lobby/match.ts carries
// them out): the party's binding to this lobby, the party itself, and the
// home lobbies a public lobby owes an away_over.
export type GroupOutbound =
	// Index the party (and each member) to this lobby.
	| { kind: 'groupBind'; partyId: string; memberIds: string[] }
	// Drop that index and the members' queue records, and break up the party.
	| { kind: 'groupUnbind'; partyId: string; memberIds: string[]; gameMode: string }
	// Break up the party (its ticket is spent; the lobby still holds the group).
	| { kind: 'groupDissolve'; partyId: string }
	| { kind: 'awayOver'; homeCode: string; partyId: string }

export interface OpenRequest {
	partyId: string
	mode: string
	teams: boolean
}

export function viewOf(lobby: Lobby): GroupQueueView | null {
	const gq = lobby.groupQueue
	if (!gq) return null
	return {
		phase: gq.phase,
		partyId: gq.partyId,
		homeCode: lobby.code,
		modId: lobby.modId,
		mode: gq.mode,
		teams: gq.teams,
		hostId: lobby.hostId,
		memberIds: gq.memberIds,
		ticket: gq.phase === 'queued' ? gq.ticket : null,
		matchId: gq.phase === 'away' ? gq.matchId : null,
		code: gq.phase === 'away' ? gq.code : null,
	}
}

export function homeFactsOf(lobby: Lobby): GroupHomeFacts {
	return {
		code: lobby.code,
		modId: lobby.modId,
		hostId: lobby.hostId,
		isPrivate: !lobby.allowedIds,
		ranked: !!lobby.rankedMode,
		started: lobby.game.started !== null,
		closed: lobby.closed,
		members: lobby.players.map((p) => ({ id: p.id, present: p.awaySince === null })),
		groupQueue: viewOf(lobby),
	}
}

function everyone(lobby: Lobby): string[] {
	return lobby.players.map((p) => p.id)
}

function announce(lobby: Lobby, reason: GroupEndReason | null, requeue = false): Outbound {
	const view = viewOf(lobby)
	const payload: GroupQueueMessage | null = view && { ...view, reason, requeue }
	return { kind: 'send', op: ServerOp.GROUP_QUEUE, payload, to: everyone(lobby) }
}

function withGroup(lobby: Lobby, groupQueue: GroupQueue | null): Lobby {
	return { ...lobby, groupQueue }
}

function ownGroup(lobby: Lobby, partyId: string): GroupQueue | null {
	const gq = lobby.groupQueue
	return gq && gq.partyId === partyId ? gq : null
}

export function openGroupQueue(
	lobby: Lobby,
	byId: string,
	request: OpenRequest,
	switches: GroupSwitches,
	now: number,
): Result<Step, GroupRefusal> {
	const refused = homeRefusal(homeFactsOf(lobby), byId, switches)
	if (refused) return err(refused)
	const memberIds = everyone(lobby)
	const next = withGroup(lobby, {
		phase: 'forming',
		partyId: request.partyId,
		mode: request.mode,
		teams: request.teams,
		memberIds,
		since: now,
	})
	return ok({
		lobby: next,
		out: [{ kind: 'groupBind', partyId: request.partyId, memberIds }, announce(next, null)],
	})
}

// The host's open was refused over a member's standing: the host has the RPC
// reply, and the other players are told who is in the way (as when a queue
// ends over a member), since no queue exists to end. Nothing changes.
export function refuseOpen(lobby: Lobby, hostId: string, partyId: string, refused: RefusedMember): Step {
	if (lobby.groupQueue) return { lobby, out: [] }
	const idle: GroupQueueMessage = {
		phase: 'idle',
		partyId,
		homeCode: lobby.code,
		reason: 'member_refused',
		requeue: false,
		refused,
	}
	const to = everyone(lobby).filter((id) => id !== hostId)
	return { lobby, out: [{ kind: 'send', op: ServerOp.GROUP_QUEUE, payload: idle, to }] }
}

// The host's party ticket is out (the PartyMatchmakerAdd after-hook).
export function groupQueued(lobby: Lobby, partyId: string, ticket: string): Result<Step, GroupRefusal> {
	const gq = ownGroup(lobby, partyId)
	if (!gq) return err({ code: 'not_bound' })
	if (gq.phase !== 'forming') return err({ code: 'not_forming' })
	const next = withGroup(lobby, { ...gq, phase: 'queued', ticket })
	return ok({ lobby: next, out: [announce(next, null)] })
}

// Back to forming, the ticket gone: the host took it back, or the match it
// was in fell through (requeue: the host queues the party again).
export function groupUnqueued(lobby: Lobby, partyId: string, requeue: boolean): Step {
	const gq = ownGroup(lobby, partyId)
	if (!gq || gq.phase !== 'queued') return { lobby, out: [] }
	const { ticket, ...rest } = gq
	const next = withGroup(lobby, { ...rest, phase: 'forming' })
	return { lobby: next, out: [announce(next, requeue ? 'match_refused' : 'ticket_removed', requeue)] }
}

// The matchmaker put the group in a public lobby: its members go there, and
// their seats here wait for them. Nobody is ready when they come back.
export function groupMatched(
	lobby: Lobby,
	partyId: string,
	matchId: string,
	code: string,
	now: number,
): Result<Step, GroupRefusal> {
	const gq = ownGroup(lobby, partyId)
	if (!gq) return err({ code: 'not_bound' })
	if (gq.phase !== 'queued') return err({ code: 'not_forming' })
	const { ticket, ...rest } = gq
	const unready = { ...lobby, game: { ...lobby.game, ready: {} } }
	const next = withGroup(unready, { ...rest, phase: 'away', matchId, code, until: now + GROUP_AWAY_CAP_MS })
	return ok({ lobby: next, out: [{ kind: 'groupDissolve', partyId }, announce(next, null)] })
}

// The group queue is over: everyone is told (with why), and its index, queue
// records and party go.
export function endGroup(lobby: Lobby, reason: GroupEndReason, refused?: RefusedMember): Step {
	const gq = lobby.groupQueue
	if (!gq) return { lobby, out: [] }
	const next = withGroup(lobby, null)
	const idle: GroupQueueMessage = { phase: 'idle', partyId: gq.partyId, homeCode: lobby.code, reason, requeue: false }
	if (refused) idle.refused = refused
	return {
		lobby: next,
		out: [
			{ kind: 'groupUnbind', partyId: gq.partyId, memberIds: gq.memberIds, gameMode: gq.mode },
			{ kind: 'send', op: ServerOp.GROUP_QUEUE, payload: idle, to: everyone(next) },
		],
	}
}

// group_queue_cancel, or a party member leaving the party. Away, there is
// nothing to cancel: the members are in their game.
export function cancelGroup(
	lobby: Lobby,
	partyId: string,
	reason: GroupEndReason,
	byId: string | null,
	refused?: RefusedMember,
): Result<Step, GroupRefusal> {
	const gq = ownGroup(lobby, partyId)
	if (!gq) return err({ code: 'not_bound' })
	if (byId !== null && gq.memberIds.indexOf(byId) === -1) return err({ code: 'not_member', userId: byId })
	if (gq.phase === 'away') return err({ code: 'group_away' })
	return ok(endGroup(lobby, reason, refused))
}

// A member leaving or kicked (or timed out): forming or queued, the group
// can't go without them; away, they just aren't coming back with it.
export function memberGone(lobby: Lobby, userId: string, reason: GroupEndReason): Step {
	const gq = lobby.groupQueue
	if (!gq || gq.memberIds.indexOf(userId) === -1) return { lobby, out: [] }
	if (gq.phase !== 'away') return endGroup(lobby, reason)
	const memberIds = gq.memberIds.filter((id) => id !== userId)
	if (memberIds.length === 0) return endGroup(lobby, reason)
	return { lobby: withGroup(lobby, { ...gq, memberIds }), out: [] }
}

// A member's socket dropped: forming or queued, the group can't go without
// them; away is everyone's sockets gone on purpose.
export function memberDisconnected(lobby: Lobby, userId: string): Step {
	const gq = lobby.groupQueue
	if (!gq || gq.phase === 'away' || gq.memberIds.indexOf(userId) === -1) return { lobby, out: [] }
	return endGroup(lobby, 'member_disconnected')
}

// The group's public game is over: the members still away there get a fresh
// grace period to come back in, the seats unparked.
function endAway(lobby: Lobby, reason: GroupEndReason, now: number): Step {
	const gq = lobby.groupQueue
	if (!gq || gq.phase !== 'away') return { lobby, out: [] }
	const players = lobby.players.map((p) =>
		p.awaySince !== null && gq.memberIds.indexOf(p.id) !== -1 ? { ...p, awaySince: now } : p,
	)
	return endGroup({ ...lobby, players }, reason)
}

export function awayOver(lobby: Lobby, partyId: string, code: string, now: number): Step {
	const gq = ownGroup(lobby, partyId)
	if (!gq || gq.phase !== 'away' || gq.code !== code) return { lobby, out: [] }
	return endAway(lobby, 'away_over', now)
}

// Away ends early once every member is back...
export function groupReturned(lobby: Lobby): Step {
	const gq = lobby.groupQueue
	if (!gq || gq.phase !== 'away') return { lobby, out: [] }
	const back = lobby.players.every((p) => gq.memberIds.indexOf(p.id) === -1 || p.awaySince === null)
	return back ? endGroup(lobby, 'all_returned') : { lobby, out: [] }
}

// ...and at the cap at the latest.
export function groupAwayCapped(lobby: Lobby, now: number): Step {
	const gq = lobby.groupQueue
	if (!gq || gq.phase !== 'away' || now < gq.until) return { lobby, out: [] }
	return endAway(lobby, 'away_cap', now)
}

// Whether the lobby's seats are parked: its group is away.
export function isParked(lobby: Lobby): boolean {
	return !!lobby.groupQueue && lobby.groupQueue.phase === 'away'
}

// has_player: a member of this lobby's away group, asked about by the public
// lobby they were matched into, is 'away' rather than seated here.
export function hasPlayerAnswer(lobby: Lobby, userId: string, forMatchId: string | undefined): 'yes' | 'no' | 'away' {
	if (!lobby.players.some((p) => p.id === userId)) return 'no'
	const gq = lobby.groupQueue
	if (gq && gq.phase === 'away' && forMatchId === gq.matchId && gq.memberIds.indexOf(userId) !== -1)
		return 'away'
	return 'yes'
}

// A public lobby made with groups tells each home once its first game is
// over, or once it closes before one finished.
export function releaseGroups(previouslyStarted: boolean, lobby: Lobby): Step {
	const groups: MatchedGroup[] = lobby.groups || []
	if (groups.length === 0 || lobby.groupsReleased) return { lobby, out: [] }
	const over = lobby.closed || (previouslyStarted && lobby.game.started === null)
	if (!over) return { lobby, out: [] }
	return {
		lobby: { ...lobby, groupsReleased: true },
		out: groups.map((g): Outbound => ({ kind: 'awayOver', homeCode: g.homeCode, partyId: g.partyId })),
	}
}
