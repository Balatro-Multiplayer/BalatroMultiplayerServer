// The checks every PvP request payload goes through before the server trusts it.

type RequestBody = { [key: string]: unknown }

export function isObject(value: unknown): value is RequestBody {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A whole number from 0 to `max`.
export function isWholeNumber(
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= max
	)
}

// An input number: a whole number from 1.
export function isMessageNumber(value: unknown): value is number {
	return isWholeNumber(value) && value > 0
}

// The one rule for a numbered input, given the newest number taken from its sender: the next
// is taken; an older one (a resend) or a skipped one (a gap) is ignored, not refused.
export function judgeMessageNumber(
	last: number,
	value: unknown,
): 'unreadable' | 'ignored' | 'next' {
	if (!isMessageNumber(value)) return 'unreadable'
	return value === last + 1 ? 'next' : 'ignored'
}

// A non-empty string of at most `max` characters.
export function isTextUpTo(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max
}
