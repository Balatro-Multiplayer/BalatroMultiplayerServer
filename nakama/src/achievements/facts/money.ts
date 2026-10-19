// Money a player spent: shop purchases (buy, open_pack, voucher record their
// cost) and rerolls. Logs from before the client recorded a reroll's cost
// ({cost}) fall back to the money_delta that follows it -- vanilla records
// the reroll, then eases the dollars (only when the reroll isn't free). Pure.
import type { LogEvent } from '../../shared/replay/events'

const PURCHASE_OPCODES: { [opcode: string]: boolean } = { buy: true, open_pack: true, voucher: true }

function nonNegative(value: unknown): number | null {
	return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null
}

// The cost a reroll or purchase recorded itself, if any.
function recordedCost(event: LogEvent): number | null {
	const args = event.args
	if (event.opcode === 'reroll') {
		if (Array.isArray(args)) return nonNegative(args[0])
		if (args !== null && typeof args === 'object') return nonNegative((args as { cost?: unknown }).cost)
		return null
	}
	return Array.isArray(args) ? nonNegative(args[3]) : null
}

// The dollars the next event took, if it is a money_delta that took some.
function followingSpend(next: LogEvent | undefined): number {
	if (!next || next.opcode !== 'money_delta') return 0
	const delta = Array.isArray(next.args) ? next.args[0] : next.args
	return typeof delta === 'number' && isFinite(delta) && delta < 0 ? -delta : 0
}

export function moneySpent(events: LogEvent[]): number {
	let spent = 0
	for (let i = 0; i < events.length; i++) {
		const event = events[i]
		if (event.opcode !== 'reroll' && !PURCHASE_OPCODES[event.opcode]) continue
		const cost = recordedCost(event)
		spent += cost !== null ? cost : followingSpend(events[i + 1])
	}
	return spent
}
