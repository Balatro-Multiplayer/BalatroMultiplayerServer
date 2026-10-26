import type {
	NakamaAccountDeletion,
	NakamaAccountDeletionError,
	NakamaNoticeAcceptance,
} from '../../contracts/INakamaAccounts.js'
import { type Result, err, ok } from '../../shared/utils/result.js'
import { callNakamaRpc } from './admin-client.js'
import { nakamaUserIdOf } from './moderation-sync.js'

// Account changes made on the website and webadmin, reaching the player's
// Nakama profile (nakama/src/player/admin.ts) so the game sees them without
// a relog. Postgres is written first; best effort here: a failure is logged.

export interface NakamaProfileEdit {
	privileges?: string[]
	useDiscordName?: boolean
	preferredJoker?: string
	// null unlinks.
	discord?: null
	notice?: { version: number; acceptedAt: number }
	chatEligible?: boolean
}

export async function editNakamaProfile(playerId: string, edit: NakamaProfileEdit): Promise<boolean> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return false
	const result = await callNakamaRpc('admin_profile_set', { userId, ...edit })
	if (!result.ok) console.warn(`[nakama] Profile of ${playerId} not updated: ${result.error}`)
	return result.ok
}

export async function acceptNakamaNotice(playerId: string, notice: NakamaNoticeAcceptance): Promise<boolean> {
	const { version, acceptedAt, chatEligible } = notice
	return editNakamaProfile(playerId, { notice: { version, acceptedAt }, chatEligible })
}

export async function linkNakamaDiscord(playerId: string, discordIdHash: string, discordUsername?: string): Promise<boolean> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return false
	const result = await callNakamaRpc('admin_discord_set', { userId, discordIdHash, discordUsername })
	if (!result.ok) console.warn(`[nakama] Discord of ${playerId} not linked: ${result.error}`)
	return result.ok
}

// Deletes the player's Nakama account after renaming them to anonymousId in
// Nakama storage (nakama/src/player/anonymize.ts).
export async function deleteNakamaAccount(
	playerId: string,
	anonymousId: string,
): Promise<Result<NakamaAccountDeletion, NakamaAccountDeletionError>> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return ok('no_account')
	const result = await callNakamaRpc('admin_account_delete', { userId, anonymousId })
	if (result.ok) return ok('deleted')
	if (result.error === 'not_found' || result.error === 'disabled') return ok('no_account')
	console.warn(`[nakama] Account of ${playerId} not deleted: ${result.error}`)
	return err('unavailable')
}
