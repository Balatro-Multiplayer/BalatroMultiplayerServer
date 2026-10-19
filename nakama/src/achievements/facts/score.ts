// A player's best single-hand score. hand_scored {score} carries each played
// hand's score as a string (Talisman's big numbers don't fit a double).
// Logs from before hand_scored only have PvP's hand_result [roundScore, ...],
// the round's running total: a hand's score is the rise since the previous
// one, and a fall means a new round began. Pure.
import type { LogEvent } from '../../shared/replay/events'

// The score text as a number: Infinity for anything too big for a double
// (e-notation past 1e308, Talisman's "e10##"/"ee" forms, "naneinf"), 0 for
// anything unreadable.
export function parseScore(text: unknown): number {
	if (typeof text === 'number') return text > 0 ? text : 0
	if (typeof text !== 'string') return 0
	const cleaned = text.replace(/[,\s]/g, '').toLowerCase()
	if (cleaned === '') return 0
	const value = Number(cleaned)
	if (!isNaN(value)) return value > 0 ? value : 0
	if (cleaned === 'naneinf' || cleaned === 'inf' || cleaned === 'infinity') return Infinity
	// Talisman notations for numbers beyond a double: "e1.2e10", "1.2ee10", "10##...".
	if (/^[0-9.]*e/.test(cleaned) || cleaned.indexOf('#') !== -1) return Infinity
	return 0
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
