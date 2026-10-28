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

// What a deletion keeps in Nakama as moderation data: the runs an open
// report or ban uses, and the Steam ID hash (in the ban index) when the
// player has a ban record. The same rules as Postgres.
export interface NakamaDeletionKeep {
	keptRunIds: string[]
	keepSteamIdHash: boolean
}

export interface INakamaAccounts {
	// Deletes the account after handling the player's data in Nakama storage
	// as Postgres does (nakama/src/player/anonymize.ts).
	delete(
		playerId: string,
		anonymousId: string,
		keep: NakamaDeletionKeep,
	): Promise<Result<NakamaAccountDeletion, NakamaAccountDeletionError>>
	// Best effort: false when Nakama was not reached or has no account.
	acceptNotice(
		playerId: string,
		notice: NakamaNoticeAcceptance,
	): Promise<boolean>
}
