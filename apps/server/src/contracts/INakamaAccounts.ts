import type { Result } from '../shared/utils/result.js'

// The player's Nakama account, as the website changes it
// (infrastructure/nakama/profile-sync.ts).

// no_account: the player has no Nakama account (never linked, Nakama off, or
// already deleted).
export type NakamaAccountDeletion = 'deleted' | 'no_account'
// unavailable: Nakama did not delete it; nothing changed.
export type NakamaAccountDeletionError = 'unavailable'

// A Notice accepted on the website, with the age answer if one was given.
export interface NakamaNoticeAcceptance {
	version: number
	acceptedAt: number
	chatEligible?: boolean
}

export interface INakamaAccounts {
	// Deletes the account after renaming the player to anonymousId in Nakama
	// storage (nakama/src/player/anonymize.ts).
	delete(
		playerId: string,
		anonymousId: string,
	): Promise<Result<NakamaAccountDeletion, NakamaAccountDeletionError>>
	// Best effort: false when Nakama was not reached or has no account.
	acceptNotice(
		playerId: string,
		notice: NakamaNoticeAcceptance,
	): Promise<boolean>
}
