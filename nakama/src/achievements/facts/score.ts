// A player's best single-hand score. hand_scored {score} carries each played
// hand's score as score text (big numbers don't fit a double).
// Logs from before hand_scored only have PvP's hand_result [roundScore, ...],
// the round's running total: a hand's score is the rise since the previous
// one, and a fall means a new round began. Pure.
import { parseLegacyScore, scoreToNumber } from '../../../../packages/types/src/big-score'
import type { LogEvent } from '../../shared/replay/events'

// The score as a number: Infinity for anything too big for a double, 0 for
// anything unreadable. Reads score text and the free-form text of old logs
// (commas, Lua exponents, Balatro notation, "naneinf").
export function parseScore(text: unknown): number {
	return scoreToNumber(parseLegacyScore(text))
}

function scoredArg(args: unknown): unknown {
	if (args !== null && typeof args === 'object' && !Array.isArray(args)) return (args as { score?: unknown }).score
	return Array.isArray(args) ? args[0] : args
}

function bestFromHandScored(events: LogEvent[]): number | null {
	let best: number | null = null
	for (const event of events) {
		if (event.opcode !== 'hand_scored') continue
		const score = parseScore(scoredArg(event.args))
		best = best === null ? score : Math.max(best, score)
	}
	return best
}

function bestFromRoundTotals(events: LogEvent[]): number {
	let best = 0
	let previous = 0
	for (const event of events) {
		if (event.opcode !== 'hand_result') continue
		const total = parseScore(Array.isArray(event.args) ? event.args[0] : null)
		const hand = total >= previous ? total - previous : total
		if (total === Infinity) return Infinity
		best = Math.max(best, hand)
		previous = total
	}
	return best
}

export function bestHandScore(events: LogEvent[]): number {
	const scored = bestFromHandScored(events)
	return scored !== null ? scored : bestFromRoundTotals(events)
}
