// ClientOp.ACTION: relays an action between players, or runs it when it is
// authoritative (src/actions/registry.ts). Pure, like state.ts.
//
// The server stamps `from` with the sender, so -- unlike MQTT, where the
// payload's `from` is whatever the client wrote -- a player can't pose as
// another, and only the server can send an authoritative action's result.
import { type ActionContext, authoritativeAction } from '../actions/registry'
import {
	type ActionEnvelope,
	type ActionRejection,
	BROADCAST_TARGET,
	SERVER_TARGET,
	ServerOp,
} from './protocol'
import { type Lobby, type Outbound, type Step, findPlayer } from './state'

export const ACTION_KEY_PATTERN = /^[a-z0-9_]{1,64}$/
export const MAX_PARAMS_BYTES = 16 * 1024
export const MAX_CID_LENGTH = 64
// Token bucket per sender: RATE_PER_SECOND refill, BURST capacity. Generous:
// replay-log actions can come in bursts of dozens after a scored hand.
export const RATE_PER_SECOND = 40
export const BURST = 100

function reject(to: string, rejection: ActionRejection): Outbound {
	return {
		kind: 'send',
		op: ServerOp.ACTION_REJECTED,
		payload: rejection,
		to: [to],
	}
}

// Spends one token from the sender's bucket; null when it's empty.
function spend(lobby: Lobby, userId: string, now: number): Lobby | null {
	const bucket = lobby.actionBudget[userId] || { tokens: BURST, at: now }
	const refilled = Math.min(
		BURST,
		bucket.tokens + ((now - bucket.at) / 1000) * RATE_PER_SECOND,
	)
	if (refilled < 1) return null
	return {
		...lobby,
		actionBudget: {
			...lobby.actionBudget,
			[userId]: { tokens: refilled - 1, at: now },
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

	const budgeted = spend(lobby, senderId, ctx.now)
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
		// The request's cid, so the sender's pending callback resolves.
		const envelope: ActionEnvelope = {
			cid,
			action: key,
			from: SERVER_TARGET,
			to: BROADCAST_TARGET,
			params: result.params,
		}
		return {
			lobby: next,
			out: [
				{
					kind: 'send',
					op: ServerOp.ACTION,
					payload: envelope,
					to: next.players.map((p) => p.id),
				},
			],
		}
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
