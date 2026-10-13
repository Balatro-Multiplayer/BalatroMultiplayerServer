// ClientOp.ACTION: relays an action between players, or runs it when it is
// authoritative (src/actions/registry.ts). Pure, like state.ts.
//
// The server stamps `from` with the sender rather than trusting the payload's,
// so a player can't pose as another, and only the server can send an
// authoritative action's result.
import {
	type ActionContext,
	LOG_EVENT_KEY,
	authoritativeAction,
} from '../actions/registry'
import { settle } from '../actions/results'
import {
	type ActionEnvelope,
	type ActionRejection,
	BROADCAST_TARGET,
	SERVER_TARGET,
	ServerOp,
	type SpectateEvent,
} from './protocol'
import { spectateEvent } from './spectate'
import {
	type Lobby,
	type Outbound,
	type Step,
	findPlayer,
	logBudgetKey,
} from './state'

export const ACTION_KEY_PATTERN = /^[a-z0-9_]{1,64}$/
export const MAX_PARAMS_BYTES = 16 * 1024
export const MAX_CID_LENGTH = 64
// Token bucket per sender: RATE_PER_SECOND refill, BURST capacity. Generous:
// a mod's own actions can come in bursts after a scored hand.
export const RATE_PER_SECOND = 40
export const BURST = 100
// mpapi_log_event has a bucket of its own, so a busy replay stream (dozens
// of events after a scored hand) never starves a player's other actions.
export const LOG_RATE_PER_SECOND = 20
export const LOG_BURST = 200

function reject(to: string, rejection: ActionRejection): Outbound {
	return {
		kind: 'send',
		op: ServerOp.ACTION_REJECTED,
		payload: rejection,
		to: [to],
	}
}

// Spends one token from the bucket for this action; null when it's empty.
function spend(
	lobby: Lobby,
	userId: string,
	key: string,
	now: number,
): Lobby | null {
	const isLog = key === LOG_EVENT_KEY
	const budgetKey = isLog ? logBudgetKey(userId) : userId
	const burst = isLog ? LOG_BURST : BURST
	const rate = isLog ? LOG_RATE_PER_SECOND : RATE_PER_SECOND
	const bucket = lobby.actionBudget[budgetKey] || { tokens: burst, at: now }
	const refilled = Math.min(
		burst,
		bucket.tokens + ((now - bucket.at) / 1000) * rate,
	)
	if (refilled < 1) return null
	return {
		...lobby,
		actionBudget: {
			...lobby.actionBudget,
			[budgetKey]: { tokens: refilled - 1, at: now },
		},
	}
}

function stringField(data: { [key: string]: unknown }, key: string): string {
	const value = data[key]
	return typeof value === 'string' ? value : ''
}

export function action(
	lobby: Lobby,
	senderId: string,
	data: { [key: string]: unknown },
	ctx: Omit<ActionContext, 'from'>,
): Step {
	const cid = stringField(data, 'cid').slice(0, MAX_CID_LENGTH)
	const key = stringField(data, 'action')
	const to = stringField(data, 'to')
	const refuse = (reason: string): Step => ({
		lobby,
		out: [reject(senderId, { cid, action: key, reason })],
	})

	const sender = findPlayer(lobby, senderId)
	if (!sender || sender.awaySince !== null) return { lobby, out: [] }
	if (!ACTION_KEY_PATTERN.test(key)) return refuse('bad_action')
	const params = data.params === undefined ? null : data.params
	if (JSON.stringify(params).length > MAX_PARAMS_BYTES)
		return refuse('too_large')

	const budgeted = spend(lobby, senderId, key, ctx.now)
	if (!budgeted) return refuse('rate_limited')

	const authoritative = authoritativeAction(key)
	if (to === SERVER_TARGET) {
		if (!authoritative) return refuse('not_authoritative')
		const result = authoritative.reduce(
			budgeted,
			{ ...ctx, from: senderId },
			params,
		)
		if ('reject' in result) return refuse(result.reject)
		const next = { ...budgeted, game: result.game }
		const out: Outbound[] = []
		const audience = result.to || 'all'
		if (audience !== 'none') {
			// The request's cid, so the sender's pending callback resolves.
			const envelope: ActionEnvelope = {
				cid,
				action: key,
				from: SERVER_TARGET,
				to: BROADCAST_TARGET,
				params: result.params,
			}
			out.push({
				kind: 'send',
				op: ServerOp.ACTION,
				payload: envelope,
				to: next.players
					.map((p) => p.id)
					.filter((id) => audience === 'all' || id !== senderId),
			})
		}
		if (result.out) out.push(...result.out)
		if (key === LOG_EVENT_KEY && audience !== 'none' && result.params)
			out.push(...spectateEvent(next, result.params as SpectateEvent))
		// A report may have been the last one the game was waiting for.
		const settled = settle(next, ctx.now)
		return { lobby: settled.lobby, out: out.concat(settled.out) }
	}
	// Only the server may send an authoritative action's result.
	if (authoritative) return refuse('authoritative_only')

	let targets: string[]
	if (to === BROADCAST_TARGET) {
		targets = budgeted.players.map((p) => p.id)
	} else if (findPlayer(budgeted, to)) {
		targets = [to]
	} else {
		return refuse('unknown_target')
	}

	const envelope: ActionEnvelope = {
		cid,
		action: key,
		from: senderId,
		to,
		params,
	}
	const responseTo = stringField(data, 'responseTo')
	if (responseTo) envelope.responseTo = responseTo.slice(0, MAX_CID_LENGTH)
	return {
		lobby: budgeted,
		out: [{ kind: 'send', op: ServerOp.ACTION, payload: envelope, to: targets }],
	}
}
