// The UTF-8 length of a text; the Nakama runtime has no TextEncoder.
export function utf8Bytes(text: string): number {
	let bytes = 0
	for (const letter of text) {
		const code = letter.codePointAt(0) ?? 0
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
	}
	return bytes
}
