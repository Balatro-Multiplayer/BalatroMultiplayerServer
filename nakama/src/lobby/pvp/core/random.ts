// A run's random draws come from its own id (and the ante).
export function seededRandom(seed: string): () => number {
	let hash = 2166136261
	for (let index = 0; index < seed.length; index++)
		hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619)
	return () => {
		hash = (hash + 0x6d2b79f5) | 0
		let mixed = Math.imul(hash ^ (hash >>> 15), 1 | hash)
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
	}
}
