import type { PlayerRecord } from '../../infrastructure/gateways/player.gateway.js'
import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { hashProviderId } from '../../shared/utils/hash.js'
import type { Result } from '../../shared/utils/result.js'

// Discord linking for players on Nakama, which owns the link
// (nakama/src/player/discord.ts). The OAuth round trip stays here; once
// Discord sends the player back, Nakama is told (admin_discord_set) and the
// player row follows, so webadmin still finds players by Discord.
export type NakamaLinkOutcome = 'linked' | 'linked_elsewhere' | 'unavailable'

export interface DiscordLinkDeps {
	players: {
		findPlayerByNakamaUserId(nakamaUserId: string): Promise<PlayerRecord | null>
		findPlayerByDiscordIdHash(hash: string): Promise<PlayerRecord | null>
		linkDiscord(playerId: string, discordIdHash: string, discordUsername?: string): Promise<void>
		unlinkDiscord(playerId: string): Promise<void>
	}
	callNakamaRpc(id: string, body: Record<string, unknown>): Promise<Result<unknown, NakamaRpcError>>
}

export function createDiscordLinkService(deps: DiscordLinkDeps) {
	return {
		async linkNakamaDiscord(nakamaUserId: string, discordId: string, discordName: string): Promise<NakamaLinkOutcome> {
			const discordIdHash = hashProviderId(discordId)
			const player = await deps.players.findPlayerByNakamaUserId(nakamaUserId)
			// A player row that already has this Discord, and isn't this
			// player's, is someone else's (whether or not they use Nakama).
			const holder = await deps.players.findPlayerByDiscordIdHash(discordIdHash)
			if (holder && holder.id !== player?.id) return 'linked_elsewhere'

			const set = await deps.callNakamaRpc('admin_discord_set', {
				userId: nakamaUserId,
				discordIdHash,
				discordUsername: discordName,
			})
			if (!set.ok) return set.error === 'conflict' ? 'linked_elsewhere' : 'unavailable'

			if (player) {
				try {
					await deps.players.linkDiscord(player.id, discordIdHash, discordName)
				} catch (err) {
					console.warn('[nakama] Discord linked on Nakama but not on player row', player.id, err)
				}
			}
			return 'linked'
		},

		// Nakama already dropped the link; the player row follows.
		async unlinkNakamaDiscord(nakamaUserId: string): Promise<void> {
			const player = await deps.players.findPlayerByNakamaUserId(nakamaUserId)
			if (player) await deps.players.unlinkDiscord(player.id)
		},
	}
}

export type DiscordLinkService = ReturnType<typeof createDiscordLinkService>
