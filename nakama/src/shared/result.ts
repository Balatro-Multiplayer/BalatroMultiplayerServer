// Errors as values: a computation that can be refused returns one of these
// instead of throwing, and the caller decides what a refusal turns into (a
// runtime error, an op to the player, a log line).
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): { ok: true; value: T } {
	return { ok: true, value }
}

export function err<E>(error: E): { ok: false; error: E } {
	return { ok: false, error }
}
