import type { Privilege } from '../shared/types/index.js'

export interface PlayerRecord {
	id: string
	steamIdHash: string | null
	discordIdHash: string | null
	discordUsername: string | null
	useDiscordName: boolean
	preferredJoker: string
	privileges: Privilege[]
	steamName: string
	chatEnabled: boolean
	chatBlocked: boolean
	tosAcceptedVersion: number
	deletedAt: Date | null
}

export interface IPlayerRepository {
	findPlayerBySteamIdHash(steamIdHash: string): Promise<PlayerRecord | null>
	findPlayerByDiscordIdHash(discordIdHash: string): Promise<PlayerRecord | null>
	findPlayerById(id: string): Promise<PlayerRecord | null>
	findPlayerBySteamName(steamName: string): Promise<PlayerRecord | null>
	createPlayer(data: {
		id: string
		steamName: string
		steamIdHash?: string
		discordIdHash?: string
		nakamaUserId?: string
		// A row for a deleted account (deletedAt set).
		deleted?: boolean
	}): Promise<PlayerRecord>
	linkSteam(playerId: string, steamIdHash: string): Promise<void>
	linkNakamaUser(playerId: string, nakamaUserId: string): Promise<void>
	linkDiscord(
		playerId: string,
		discordIdHash: string,
		discordUsername?: string,
	): Promise<void>
	unlinkDiscord(playerId: string): Promise<void>
	updateUseDiscordName(playerId: string, useDiscordName: boolean): Promise<void>
	updateDiscordUsername(
		playerId: string,
		discordUsername: string,
	): Promise<void>
	updatePreferredJoker(playerId: string, preferredJoker: string): Promise<void>
	updateSteamName(playerId: string, steamName: string): Promise<void>
	recordNoticeAcceptance(
		playerId: string,
		version: number,
		acceptedAt: Date,
	): Promise<void>
	updateChatStatus(
		playerId: string,
		chatEnabled: boolean,
		chatBlocked: boolean,
	): Promise<void>
	// Account deletion: the player id becomes anonymousId everywhere
	// (gateways/player-anonymization.gateway.ts).
	anonymizePlayer(playerId: string, anonymousId: string): Promise<void>
	reactivateIfDeleted(playerId: string): Promise<void>
}
