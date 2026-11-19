// Helpers the two server-owned drafts (almanac decks, shared rules) have in common.
import { ServerOp } from './protocol'
import type { Lobby, Step } from './state'

// A deterministic generator seed from an id string: the same id always
// rolls the same numbers, so a recovered match repeats its draft.
export function seededRng(id: string): number {
	let rng = 1
	for (let i = 0; i < id.length; i++)
		rng = (rng * 31 + id.charCodeAt(i)) % 2147483647
	return rng
}

export function nextRng(rng: number): number {
	return (rng * 16807) % 2147483647
}

// A step that tells only the sender why its action was refused.
export function rejectStep(
	lobby: Lobby,
	from: string,
	action: string,
	reason: string,
): Step {
	return {
		lobby,
		out: [
			{
				kind: 'send',
				op: ServerOp.ACTION_REJECTED,
				to: [from],
				payload: { action, reason },
			},
		],
	}
}

// Action params as a plain object; anything else reads as no params.
export function paramsObject(input: unknown): { [key: string]: unknown } {
	return input && typeof input === 'object' && !Array.isArray(input)
		? (input as { [key: string]: unknown })
		: {}
}
