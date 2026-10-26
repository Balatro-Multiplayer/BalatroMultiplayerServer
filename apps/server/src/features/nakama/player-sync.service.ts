import { randomUUID } from 'node:crypto'
import type { BanRecord } from '../../infrastructure/gateways/ban.gateway.js'
import type { PlayerRecord } from '../../infrastructure/gateways/player.gateway.js'

// A player's Postgres data as Nakama stores it at their first Nakama login
// (nakama/src/player/sync.ts). Mutes are Nakama user ids; muted players who
// have never logged in to Nakama stay as legacy player ids until they do.
export interface PlayerSync {
	playerId: string
	steamName: string
	useDiscordName: boolean
	preferredJoker: string
	discordIdHash: string | null
	discordUsername: string | null
	privileges: string[]
	tosAcceptedVersion: number
	// When that version was accepted (ms), or null.
	noticeAcceptedAt: number | null
	chatEnabled: boolean
	chatBlocked: boolean
	mutedUserIds: string[]
	unresolvedMutedPlayerIds: string[]
	bans: SyncedBan[]
}

export interface SyncedBan {
	banId: string
	type: BanRecord['banType']
	expiresAt: number | null
	reason: string
}

export interface PlayerSyncDeps {
	players: {
		findPlayerBySteamIdHash(hash: string): Promise<PlayerRecord | null>
		createPlayer(data: { id: string; steamName: string; steamIdHash?: string; nakamaUserId?: string }): Promise<PlayerRecord>
		linkNakamaUser(playerId: string, nakamaUserId: string): Promise<void>
		updateSteamName(playerId: string, steamName: string): Promise<void>
		reactivateIfDeleted(playerId: string): Promise<void>
		findNakamaUserIds(playerIds: string[]): Promise<Map<string, string>>
	}
	bans: { getActiveBans(playerId: string): Promise<BanRecord[]> }
	mutes: { listMutes(muterId: string): Promise<string[]> }
}

export function syncedBanOf(ban: BanRecord): SyncedBan {
	return {
		banId: ban.id,
		type: ban.banType,
		expiresAt: ban.expiresAt ? ban.expiresAt.getTime() : null,
		reason: ban.reason,
	}
}

export type PlayerSyncService = ReturnType<typeof createPlayerSyncService>

export function createPlayerSyncService(deps: PlayerSyncDeps) {
	const { players, bans, mutes } = deps

	async function resolveMutes(playerIds: string[]) {
		const found = await players.findNakamaUserIds(playerIds)
		return {
			resolved: playerIds.filter((id) => found.has(id)).map((id) => found.get(id)!),
			unresolved: playerIds.filter((id) => !found.has(id)),
		}
	}

	// Finds (or creates) the player row for a Steam account and records its
	// Nakama user id, so Postgres-side features (reports, bans, webadmin) can
	// reach the Nakama account.
	async function syncPlayer(input: { steamIdHash: string; nakamaUserId: string; steamName: string }): Promise<PlayerSync> {
		const { steamIdHash } = input
		let player = await players.findPlayerBySteamIdHash(steamIdHash)
		if (player) {
			await players.linkNakamaUser(player.id, input.nakamaUserId)
			if (input.steamName) await players.updateSteamName(player.id, input.steamName)
			if (player.deletedAt) await players.reactivateIfDeleted(player.id)
		} else {
			player = await players.createPlayer({
				id: randomUUID(),
				steamName: input.steamName,
				steamIdHash,
				nakamaUserId: input.nakamaUserId,
			})
		}

		const muted = await resolveMutes(await mutes.listMutes(player.id))
		const active = await bans.getActiveBans(player.id)
		return {
			playerId: player.id,
			steamName: input.steamName || player.steamName,
			useDiscordName: player.useDiscordName,
			preferredJoker: player.preferredJoker,
			discordIdHash: player.discordIdHash,
			discordUsername: player.discordUsername,
			privileges: player.privileges,
			tosAcceptedVersion: player.tosAcceptedVersion,
			noticeAcceptedAt: player.noticeAcceptedAt ? player.noticeAcceptedAt.getTime() : null,
			chatEnabled: player.chatEnabled,
			chatBlocked: player.chatBlocked,
			mutedUserIds: muted.resolved,
			unresolvedMutedPlayerIds: muted.unresolved,
			bans: active.map(syncedBanOf),
		}
	}

	return { syncPlayer, resolveMutes }
}
