// What chat_send does before (or instead of) the moderation service, as in the
// API's features/chat/{normalization,obscenity}.ts: messages on the webadmin
// allowlist skip moderation entirely, and with the service switched off
// (MODERATION_REMOTE=off) a local word list judges instead.
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'

// The allowlist key for a message: trimmed, lowercased, one trailing . ! or ?
// dropped (a message that is only punctuation is kept whole). null when blank.
// Only for lookup: the original message is what gets published and logged.
export function normalizeForAllowlist(message: string): string | null {
	const trimmed = message.trim()
	if (trimmed === '') return null
	const lower = trimmed.toLowerCase()
	if (/^[.!?]+$/.test(lower)) return lower
	if (lower.endsWith('.') || lower.endsWith('!') || lower.endsWith('?')) return lower.slice(0, -1)
	return lower
}

export function isAllowlisted(message: string, allowlist: string[]): boolean {
	const key = normalizeForAllowlist(message)
	return key !== null && allowlist.indexOf(key) !== -1
}

export interface ObscenityMatch {
	word: string
	startIndex: number
	endIndex: number
}

let matcher: RegExpMatcher | null = null

// The words a message was blocked for; empty when it is clean.
export function obscenityMatches(message: string): ObscenityMatch[] {
	if (!matcher) matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers })
	return matcher.getAllMatches(message).map((m) => {
		const metadata = englishDataset.getPayloadWithPhraseMetadata(m).phraseMetadata
		return { word: (metadata && metadata.originalWord) || '', startIndex: m.startIndex, endIndex: m.endIndex }
	})
}

export function remoteModerationEnabled(env: { [key: string]: string }): boolean {
	return env.MODERATION_REMOTE !== 'off'
}
