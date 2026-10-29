// Score text: the one form every score takes on the wire and in storage.
//
// A score is the normalized OmegaNum array, entries joined by ",", from
// array[1] up. array[1] is written in its shortest exact form (up to 17
// digits, so the double comes back exactly); the higher entries are integers.
// "100,1" is 10^100. "20,2" is 10^10^20. "12345" is 12345.
//
// Normalizing and comparing follow OmegaNum.js (`normalize`, `cmp`). The Lua
// twin is BalatroMultiplayerAPI lib/big_score.lua (MPAPI.BigScore); both are
// tested with the same vector table. Change both together.
//
// Value rules: scores are whole numbers (rounded down); a negative score is
// "0"; a vanilla inf or NaN is the largest double; a Talisman or Amulet
// Infinity or NaN is TOP_SCORE, the top value the array limit allows.
//
// Plain ES2015 with no imports: the Nakama bundle includes this file too.

export const MAX_SAFE = 9007199254740991
// The longest array a score may have. It guards against huge messages.
export const MAX_ARRAY_LENGTH = 100
// Longer text than any valid score is refused before it is split.
const MAX_TEXT_LENGTH = 4096
const LOG_MAX_SAFE = Math.log10(MAX_SAFE)
// Balatro switches from digits to e-notation at this value.
const E_SWITCH_POINT = 100000000000

export const ZERO_SCORE = '0'
export const TOP_SCORE = new Array(MAX_ARRAY_LENGTH)
	.fill(String(MAX_SAFE))
	.join(',')

const ENTRY_FIRST = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
const ENTRY_HIGHER = /^(0|[1-9][0-9]*)$/

const TOP_ARRAY = (): number[] => new Array(MAX_ARRAY_LENGTH).fill(MAX_SAFE)

// OmegaNum.js `normalize` for a positive sign. Returns TOP's array when the
// result is longer than the limit.
function normalizeArray(input: number[]): number[] {
	if (input.length === 0) return [0]
	if (input.length > MAX_ARRAY_LENGTH) return TOP_ARRAY()
	const x = input.slice()
	for (let i = 0; i < x.length; i++) {
		const e = x[i]
		if (
			Number.isNaN(e) ||
			e === Number.POSITIVE_INFINITY ||
			e === Number.NEGATIVE_INFINITY
		) {
			return TOP_ARRAY()
		}
		if (i !== 0 && e !== Math.floor(e)) x[i] = Math.floor(e)
	}
	let again: boolean
	do {
		again = false
		while (x.length > 0 && x[x.length - 1] === 0) {
			x.pop()
			again = true
		}
		if (x[0] > MAX_SAFE) {
			x[1] = (x[1] || 0) + 1
			x[0] = Math.log10(x[0])
			again = true
		}
		while (x[0] < LOG_MAX_SAFE && x[1]) {
			x[0] = 10 ** x[0]
			x[1]--
			again = true
		}
		if (x.length > 2 && !x[1]) {
			let i = 2
			while (!x[i]) i++
			x[i - 1] = Math.floor(x[0])
			x[0] = 10 ** (x[0] - Math.floor(x[0]))
			x[i]--
			again = true
		}
		for (let i = 1; i < x.length; i++) {
			if (x[i] > MAX_SAFE) {
				x[i + 1] = (x[i + 1] || 0) + 1
				x[0] = x[i] + 1
				for (let j = 1; j <= i; j++) x[j] = 0
				again = true
			}
		}
		if (x.length > MAX_ARRAY_LENGTH) return TOP_ARRAY()
	} while (again)
	if (x.length === 0) return [0]
	for (let i = 0; i < x.length; i++) if (x[i] === undefined) x[i] = 0
	if (x.length === 1) x[0] = Math.floor(x[0])
	return x
}

// array[1]: an exact integer, or the shortest of 15, 16 and 17 significant
// digits that reads back as the same double. Never exponent notation.
function writeFirst(x: number): string {
	if (x === Math.floor(x)) return x.toFixed(0)
	for (let digits = 15; digits <= 17; digits++) {
		const s = x.toPrecision(digits)
		if (s.indexOf('e') === -1 && Number(s) === x) {
			return s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, '')
		}
	}
	return x.toPrecision(17)
}

function writeArray(array: number[]): string {
	const parts = [writeFirst(array[0])]
	for (let i = 1; i < array.length; i++) parts.push(array[i].toFixed(0))
	return parts.join(',')
}

// Splits score text into numbers; null when the text is malformed or the array
// is longer than the limit.
function readArray(text: string): number[] | null {
	if (
		typeof text !== 'string' ||
		text.length === 0 ||
		text.length > MAX_TEXT_LENGTH
	)
		return null
	const parts = text.split(',')
	if (parts.length > MAX_ARRAY_LENGTH) return null
	const array: number[] = []
	for (let i = 0; i < parts.length; i++) {
		if (!(i === 0 ? ENTRY_FIRST : ENTRY_HIGHER).test(parts[i])) return null
		const n = Number(parts[i])
		if (!Number.isFinite(n)) return null
		array.push(n)
	}
	return array
}

/** Score text of a plain double. Vanilla inf and NaN are the largest double. */
export function fromNumber(n: number): string {
	const value =
		Number.isNaN(n) || n === Number.POSITIVE_INFINITY ? Number.MAX_VALUE : n
	if (value < 1) return ZERO_SCORE
	return writeArray(normalizeArray([Math.floor(value)]))
}

/**
 * Score text of an OmegaNum array and sign, as Talisman or Amulet hold it.
 * Infinity and NaN entries give TOP_SCORE; a negative sign gives "0".
 */
export function fromArray(array: number[], sign: number): string {
	if (sign < 0) return ZERO_SCORE
	return writeArray(normalizeArray(array))
}

/** Canonical score text, or null when the text is malformed. */
export function normalizeScore(text: string): string | null {
	const array = readArray(text)
	return array === null ? null : writeArray(normalizeArray(array))
}

/** -1, 0 or 1 like OmegaNum `cmp`, or null when either text is malformed. */
export function compareScores(a: string, b: string): -1 | 0 | 1 | null {
	const x = readArray(a)
	const y = readArray(b)
	if (x === null || y === null) return null
	const p = normalizeArray(x)
	const q = normalizeArray(y)
	if (p.length !== q.length) return p.length > q.length ? 1 : -1
	for (let i = p.length - 1; i >= 0; i--) {
		if (p[i] > q[i]) return 1
		if (p[i] < q[i]) return -1
	}
	return 0
}

/**
 * The Postgres sort key: the normalized array length, and the array from the
 * top entry down. Comparing (len, rev) row-wise gives the OmegaNum order.
 * Null when the text is malformed.
 */
export function scoreSortKey(
	text: string,
): { len: number; rev: number[] } | null {
	const array = readArray(text)
	if (array === null) return null
	const x = normalizeArray(array)
	return { len: x.length, rev: x.slice().reverse() }
}

const GROUPED_INTEGER = /^\d{1,3}(,\d{3})+$/
const HYPER_E = /^(e*)([0-9]+(?:\.[0-9]+)?)e\+?([0-9]+)$/

/**
 * Score text of text from a log written before score text existed: commas
 * ("2,832"), Lua exponent text ("1.5e+20"), Balatro notation ("1.235e1,234",
 * "e1.2e10"), "nan", "inf", "infinity" and "naneinf" (the largest double), and Talisman's array forms (the top score). A number
 * is read as a double. Anything unreadable is "0". Text that is already score
 * text comes back normalized, except comma-grouped digits: those are read as
 * an integer, because every old client wrote them that way.
 */
export function parseLegacyScore(input: unknown): string {
	if (typeof input === 'number') return fromNumber(input)
	if (typeof input !== 'string') return ZERO_SCORE
	const text = input.trim()
	if (GROUPED_INTEGER.test(text)) return fromNumber(Number(text.replace(/,/g, '')))
	const normal = normalizeScore(text)
	if (normal !== null) return normal
	const cleaned = text.replace(/[,\s]/g, '').toLowerCase()
	if (cleaned === '') return ZERO_SCORE
	const value = Number(cleaned)
	if (!Number.isNaN(value) && (Number.isFinite(value) || !HYPER_E.test(cleaned))) return fromNumber(value)
	if (cleaned === 'naneinf' || cleaned === 'nan' || cleaned === 'inf' || cleaned === 'infinity')
		return fromNumber(Number.POSITIVE_INFINITY)
	const tower = HYPER_E.exec(cleaned)
	if (tower !== null) {
		const layers = tower[1].length
		const inner = Number(tower[2] + 'e' + tower[3])
		if (Number.isFinite(inner)) return fromArray([inner, layers], 1)
		return fromArray([Number(tower[3]) + Math.log10(Number(tower[2])), layers + 1], 1)
	}
	if (/^[0-9.]*e/.test(cleaned) || cleaned.indexOf('#') !== -1) return TOP_SCORE
	return ZERO_SCORE
}

/**
 * The score as a double: Infinity above the largest double, 0 for malformed
 * text. For thresholds only; never store it.
 */
export function scoreToNumber(text: string): number {
	const array = readArray(text)
	if (array === null) return 0
	const a = normalizeArray(array)
	if (a.length === 1) return a[0]
	if (a.length > 2) return Number.POSITIVE_INFINITY
	let value = a[0]
	for (let i = 0; i < a[1] && value !== Number.POSITIVE_INFINITY; i++) value = Math.pow(10, value)
	return value
}

// --- Display: Balatro notation (the Talisman "Balatro" notation) ---
// Mantissas are rounded half up to 3 decimals. A mantissa that rounds to 10
// becomes 1 with the exponent plus one. Digits come from integer math so both
// sides print the same text.

function groupDigits(digits: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// The first 4 significant digits of a whole number, rounded half up by the 5th
// digit, and the power of ten: value is about M / 1000 * 10^exp.
function fourDigits(whole: number): { m: number; exp: number } {
	const digits = Math.floor(whole).toFixed(0)
	let m = Number(digits.slice(0, 4).padEnd(4, '0'))
	let exp = digits.length - 1
	if (digits.length > 4 && digits.charCodeAt(4) >= 53) m++
	if (m >= 10000) {
		m = 1000
		exp++
	}
	return { m, exp }
}

function mantissaText(m: number): string {
	const whole = Math.floor(m / 1000)
	const fraction = String(m % 1000)
		.padStart(3, '0')
		.replace(/0+$/, '')
	return fraction === '' ? String(whole) : `${whole}.${fraction}`
}

// A mantissa in [1, 10) as thousandths, and the carry into the exponent.
function roundMantissa(mantissa: number): { m: number; carry: number } {
	const m = Math.floor(mantissa * 1000 + 0.5)
	return m >= 10000 ? { m: 1000, carry: 1 } : { m, carry: 0 }
}

// Vanilla number_format for a number in an exponent or array entry.
function formatEntry(num: number): string {
	if (num >= 1000000) {
		const { m, exp } = fourDigits(num)
		return `${(m / 1000).toFixed(3)}e${exp}`
	}
	if (num === Math.floor(num)) return groupDigits(num.toFixed(0))
	const places = num >= 100 ? 0 : num >= 10 ? 1 : 2
	const scaled = Math.floor(num * 10 ** places + 0.5)
	const whole = Math.floor(scaled / 10 ** places)
	const text = groupDigits(String(whole))
	return places === 0
		? text
		: `${text}.${String(scaled % 10 ** places).padStart(places, '0')}`
}

function roundThousandths(num: number): number {
	return Math.floor(num * 1000 + 0.5) / 1000
}

function displayArray(a: number[]): string {
	if (a.length === 1) {
		if (a[0] < E_SWITCH_POINT) return groupDigits(a[0].toFixed(0))
		const { m, exp } = fourDigits(a[0])
		return `${mantissaText(m)}e${formatEntry(exp)}`
	}
	const first = a[0]
	if (a.length === 2 && a[1] === 1 && first >= 1000000) {
		const exp = Math.floor(Math.log10(first))
		const { m, carry } = roundMantissa(first / 10 ** exp)
		return `e${mantissaText(m)}e${formatEntry(exp + carry)}`
	}
	if (a.length === 2 && a[1] <= 8) {
		const exp = Math.floor(first)
		const { m, carry } = roundMantissa(10 ** (first - exp))
		return `${'e'.repeat(a[1] - 1)}${mantissaText(m)}e${formatEntry(exp + carry)}`
	}
	if (a.length < 8) {
		let text = `e${formatEntry(roundThousandths(first))}#${formatEntry(a[1])}`
		for (let i = 2; i < a.length; i++) text += `#${formatEntry(a[i] + 1)}`
		return text
	}
	return `e${formatEntry(roundThousandths(first))}#${formatEntry(a[a.length - 1])}##${formatEntry(a.length - 2)}`
}

/** Text for people in Balatro notation, or null when the text is malformed. Never parsed back. */
export function displayScore(text: string): string | null {
	const array = readArray(text)
	return array === null ? null : displayArray(normalizeArray(array))
}
