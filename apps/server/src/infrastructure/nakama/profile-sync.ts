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
}

export async function editNakamaProfile(playerId: string, edit: NakamaProfileEdit): Promise<boolean> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return false
	const result = await callNakamaRpc('admin_profile_set', { userId, ...edit })
	if (!result.ok) console.warn(`[nakama] Profile of ${playerId} not updated: ${result.error}`)
	return result.ok
}

export async function linkNakamaDiscord(playerId: string, discordIdHash: string, discordUsername?: string): Promise<boolean> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return false
	const result = await callNakamaRpc('admin_discord_set', { userId, discordIdHash, discordUsername })
	if (!result.ok) console.warn(`[nakama] Discord of ${playerId} not linked: ${result.error}`)
	return result.ok
}

export async function deleteNakamaAccount(playerId: string): Promise<boolean> {
	const userId = await nakamaUserIdOf(playerId)
	if (!userId) return false
	const result = await callNakamaRpc('admin_account_delete', { userId })
	if (!result.ok) console.warn(`[nakama] Account of ${playerId} not deleted: ${result.error}`)
	return result.ok
}
