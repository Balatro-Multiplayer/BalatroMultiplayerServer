// The home lobby's answers to the group queue's signals (matchmaking/group
// asks and tells it through matchSignal), as pure steps: lobby/match.ts
// carries out the step and hands back the reply.
import type { GroupRefusal, GroupSwitches } from '../matchmaking/group/refusal'
import type { Result } from '../shared/result'
import {
	awayOver,
	cancelGroup,
	groupMatched,
	groupQueued,
	groupUnqueued,
	homeFactsOf,
	openGroupQueue,
	refuseOpen,
	viewOf,
} from './group_queue'
import type { GroupQueueView, LobbySignal } from './protocol'
import type { Lobby, Step } from './state'

export type GroupSignal = Extract<
	LobbySignal,
	{
		type:
			| 'group_members'
			| 'group_status'
			| 'group_open'
			| 'group_open_refused'
			| 'group_queued'
			| 'group_unqueued'
			| 'group_requeue'
			| 'group_matched'
			| 'group_cancel'
			| 'away_over'
	}
>

const GROUP_SIGNALS: GroupSignal['type'][] = [
	'group_members',
	'group_status',
	'group_open',
	'group_open_refused',
	'group_queued',
	'group_unqueued',
	'group_requeue',
	'group_matched',
	'group_cancel',
	'away_over',
]

export function isGroupSignal(signal: LobbySignal): signal is GroupSignal {
	return (GROUP_SIGNALS as string[]).indexOf(signal.type) !== -1
}

// What a transition replies: the group queue after it, or why it was refused.
export type GroupReply = { groupQueue: GroupQueueView | null } | { refused: GroupRefusal }

export interface Answer {
	step: Step
	reply: string
}

function unchanged(lobby: Lobby, reply: unknown): Answer {
	return { step: { lobby, out: [] }, reply: JSON.stringify(reply) }
}

function answered(lobby: Lobby, result: Result<Step, GroupRefusal>): Answer {
	if (!result.ok) return unchanged(lobby, { refused: result.error } as GroupReply)
	return { step: result.value, reply: JSON.stringify({ groupQueue: viewOf(result.value.lobby) } as GroupReply) }
}

function stepped(step: Step): Answer {
	return { step, reply: JSON.stringify({ groupQueue: viewOf(step.lobby) } as GroupReply) }
}

export function answerGroupSignal(lobby: Lobby, signal: GroupSignal, switches: GroupSwitches, now: number): Answer {
	switch (signal.type) {
		case 'group_members':
			return unchanged(lobby, homeFactsOf(lobby))
		case 'group_status': {
			const view = viewOf(lobby)
			return unchanged(lobby, view && view.partyId === signal.partyId ? view : null)
		}
		case 'group_open':
			return answered(
				lobby,
				openGroupQueue(lobby, signal.userId, { partyId: signal.partyId, mode: signal.mode, teams: signal.teams }, switches, now),
			)
		case 'group_open_refused':
			return stepped(refuseOpen(lobby, signal.userId, signal.partyId, signal.refused))
		case 'group_queued':
			return answered(lobby, groupQueued(lobby, signal.partyId, signal.ticket))
		case 'group_unqueued':
			return stepped(groupUnqueued(lobby, signal.partyId, false))
		case 'group_requeue':
			return stepped(groupUnqueued(lobby, signal.partyId, true))
		case 'group_matched':
			return answered(lobby, groupMatched(lobby, signal.partyId, signal.matchId, signal.code, now))
		case 'group_cancel':
			return answered(lobby, cancelGroup(lobby, signal.partyId, signal.reason, signal.userId || null, signal.refused))
		case 'away_over':
			return stepped(awayOver(lobby, signal.partyId, signal.code, now))
	}
}
