// Card keys from replay card refs (MPAPI api/replay/recorder.lua
// RLOG.card_ref). A card's first reference carries its key,
// [-id, set, center_key, tags...] (or [-id, "pc", suit, value, tags...] for a
// playing card); every later one is just [id, tags...]. So the key of a
// later reference comes from the log's earlier events. Pure.

export type CardKeys = { [id: number]: string }

function isFirstSeenRef(value: unknown): value is [number, string, ...unknown[]] {
	return (
		Array.isArray(value) &&
		typeof value[0] === 'number' &&
		value[0] < 0 &&
		value[0] % 1 === 0 &&
		typeof value[1] === 'string'
	)
}

// Learns every first-seen ref anywhere inside args (refs nest inside lists:
// play's refs, reorder's moved entries, use's target refs).
export function learnRefs(keys: CardKeys, args: unknown): void {
	if (isFirstSeenRef(args)) {
		const id = -args[0]
		if (args[1] !== 'pc' && typeof args[2] === 'string') keys[id] = args[2]
		return
	}
	if (Array.isArray(args)) for (const item of args) learnRefs(keys, item)
	else if (args !== null && typeof args === 'object')
		for (const field in args as { [k: string]: unknown }) learnRefs(keys, (args as { [k: string]: unknown })[field])
}

// The center key a ref names, if the log has said.
export function keyOfRef(keys: CardKeys, ref: unknown): string | null {
	if (!Array.isArray(ref) || typeof ref[0] !== 'number') return null
	if (ref[0] < 0) return ref[1] !== 'pc' && typeof ref[2] === 'string' ? ref[2] : null
	return keys[ref[0]] ?? null
}
