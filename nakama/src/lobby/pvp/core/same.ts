// Equal by value. The match state comes back from Nakama's JS runtime as a new object at every
// read, so a rule that asks "did this change" compares values, never references.
const isRecord = (value: unknown): value is { [key: string]: unknown } =>
	typeof value === 'object' && value !== null

// Arrays count: they are compared by index.
export function same(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (!isRecord(a) || !isRecord(b)) return false
	const names = Object.keys(a)
	return (
		names.length === Object.keys(b).length &&
		names.every((name) => name in b && same(a[name], b[name]))
	)
}
