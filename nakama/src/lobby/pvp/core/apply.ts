// One input from one player: the header rules, then the kind's handler.
//
// The header: inputs are taken in order, once each. The next number is taken whether the
// kind's transition ran or was refused, so one bad message never stalls the sequence; a
// number already taken (a resend) or too far ahead (a gap) is ignored: normal traffic,
// not a refusal. A refused input changes nothing but that number and its last item done.
// Refusals are returned for the shell to log, never answered to the player.
//
// Dispatch: one row per kind in `inputHandlers`, naming its body spec and its handler. Each
// handler's change adds its rows.
import { readyHandler, teamHandler } from '../inputs/entry'
import {
	endGameHandler,
	forfeitHandler,
	jokersHandler,
	voteHandler,
} from '../inputs/finish'
import {
	blindStartHandler,
	handPlayedHandler,
	handScoredHandler,
	openPvpBlindIfReady,
} from '../inputs/pvp_blind'
import {
	blindResultHandler,
	progressHandler,
	sellHandler,
	shopHandler,
	skipHandler,
	voucherHandler,
} from '../inputs/run'
import {
	animatingHandler,
	timerPauseHandler,
	paidPreviewsHandler,
	timerStartHandler,
} from '../inputs/timer'
import { type InputValues, type InputFields, readInput } from './read_input'
import { dropUnneededTimers } from '../inputs/timer_run_out'
import {
	isMessageNumber,
	isObject,
	isWholeNumber,
	judgeMessageNumber,
} from './request_checks'
import { changeRunPlayer } from './run_player'
import { recordLastItemDone } from './inbox'
import type { InputResult, Milliseconds, PlayerId, State } from './types'

// A handler's answer: the new state, or the reason the input was refused.
export type Handled = State | { refusal: string }

export interface InputHandler<Spec extends InputFields = InputFields> {
	spec: Spec
	// Only `team` is taken without a run. The game cannot write null, so a missing runId also means no run.
	beforeRun?: true
	handle(
		state: State,
		player: PlayerId,
		body: InputValues<Spec>,
		now: Milliseconds,
		// The highest total seen for the input's key before this input; null for a kind
		// with no total.
		previousTotal: number | null,
	): Handled
}

export type InputHandlers = { readonly [kind: string]: InputHandler }

export const inputHandlers: InputHandlers = {
	ready: readyHandler,
	team: teamHandler,
	blindStart: blindStartHandler,
	handPlayed: handPlayedHandler,
	handScored: handScoredHandler,
	progress: progressHandler,
	blindResult: blindResultHandler,
	skip: skipHandler,
	sell: sellHandler,
	shop: shopHandler,
	voucher: voucherHandler,
	timerStart: timerStartHandler,
	timerPause: timerPauseHandler,
	paidPreviews: paidPreviewsHandler,
	animating: animatingHandler,
	vote: voteHandler,
	forfeit: forfeitHandler,
	jokers: jokersHandler,
	endGame: endGameHandler,
}

// `applied` has no transition: its last applied number is all it says.
const applied: InputHandler = { spec: {}, handle: (state) => state }

// The key a total is counted under, or null for a kind with no total.
export function totalKey(input: {
	kind: string
	[field: string]: unknown
}): string | null {
	switch (input.kind) {
		case 'skip':
			return 'skip'
		case 'sell':
			return `sell:${String(input.ante)}`
		case 'shop':
			return 'shop'
		case 'paidPreviews':
			return 'paidPreviews'
		default:
			return null
	}
}

function refuse(state: State, code: string): InputResult {
	return { state, refusals: [code] }
}

function handlerOf(
	kind: unknown,
	table: InputHandlers,
): InputHandler | undefined {
	if (typeof kind !== 'string') return undefined
	if (kind === 'applied') return applied
	return Object.prototype.hasOwnProperty.call(table, kind)
		? table[kind]
		: undefined
}

function take(
	state: State,
	player: PlayerId,
	fields: { [field: string]: unknown },
	now: Milliseconds,
	table: InputHandlers,
): InputResult {
	const { kind, runId, ...rest } = fields
	const handler = handlerOf(kind, table)
	// A decided match takes only its players' last words: the inputs that follow the
	// deciding one in the same step find it decided.
	if (
		handler !== undefined &&
		state.result !== null &&
		kind !== 'endGame' &&
		kind !== 'applied'
	)
		return refuse(state, 'already_decided')
	const body = handler === undefined ? null : readInput(handler.spec, rest)
	if (handler === undefined || body === null || typeof kind !== 'string')
		return refuse(state, 'bad_request_body')
	if (handler.beforeRun === true) {
		if (runId !== null && runId !== undefined)
			return refuse(state, 'bad_request_body')
	} else {
		if (typeof runId !== 'string') return refuse(state, 'bad_request_body')
		if (state.run?.id !== runId) return refuse(state, 'wrong_run')
		if (state.run.players[player] === undefined)
			return refuse(state, 'unknown_player')
	}

	const key = totalKey({ kind, ...body })
	const total = body.total
	const counted =
		key !== null && typeof total === 'number' ? { key, total } : null
	// The highest total seen before this input. The handler gets the old value; the new
	// one is written after it.
	const seen =
		counted === null
			? 0
			: (state.run?.players[player]?.totals[counted.key] ?? 0)
	if (counted !== null && counted.total <= seen) return { state, refusals: [] }

	const handled = handler.handle(
		state,
		player,
		body,
		now,
		counted === null ? null : seen,
	)
	if ('refusal' in handled) return refuse(state, handled.refusal)
	return {
		state:
			counted === null
				? handled
				: changeRunPlayer(handled, player, (entry) => ({
						...entry,
						totals: { ...entry.totals, [counted.key]: counted.total },
					})),
		refusals: [],
	}
}

// What an input did, and the newest number taken from its sender afterwards: `last` when the
// input was refused as unreadable or ignored.
export interface NumberedResult extends InputResult {
	lastNumber: number
}

// `last` is the newest number taken from this player (the lobby's `messageNumbers`); the
export function apply(
	state: State,
	player: PlayerId,
	input: unknown,
	last: number,
	now: Milliseconds,
	table: InputHandlers = inputHandlers,
): NumberedResult {
	const unchanged = (result: InputResult): NumberedResult => ({
		...result,
		lastNumber: last,
	})
	if (state.players[player] === undefined)
		return unchanged(refuse(state, 'unknown_player'))
	if (!isObject(input)) return unchanged(refuse(state, 'unreadable_header'))
	const { messageNumber, inboxDone, ...fields } = input
	if (!isMessageNumber(messageNumber) || !isWholeNumber(inboxDone))
		return unchanged(refuse(state, 'unreadable_header'))
	if (judgeMessageNumber(last, messageNumber) === 'ignored')
		return unchanged({ state, refusals: [] })

	// The header counts for the run it names, whatever the body or its handler does.
	const noted =
		state.run !== null && fields.runId === state.run.id
			? recordLastItemDone(state, player, inboxDone)
			: { state, refusals: [] }
	const taken = take(noted.state, player, fields, now, table)
	// An input can change who a Boss needs or who is Ready: the timers nothing needs go, and
	// the PvP blind starts if it can.
	const settled = dropUnneededTimers(openPvpBlindIfReady(taken.state, now), now)
	return {
		state: settled,
		refusals: [...noted.refusals, ...taken.refusals],
		lastNumber: messageNumber,
	}
}
