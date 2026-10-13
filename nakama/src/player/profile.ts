// A player's account data that lives on Nakama: what the BMP API kept in its
// players row and in-memory session (names, joker, Discord, ToS, chat flags,
// privileges, mutes). Owned by the player, readable by them, written only by
// the server. Brought over from Postgres once, at the first session_init
// (player/session.ts).
import { DEFAULT_JOKER, privilegeTable } from '../shared/jokers'

export const PLAYER_COLLECTION = 'player'
export const PROFILE_KEY = 'profile'

const MAX_NAME_LENGTH = 64
const WRITE_ATTEMPTS = 3

export interface Profile {
	steamName: string
	useDiscordName: boolean
	preferredJoker: string
	// The player's installed mods, as the client last reported them.
	mods: unknown
	discordIdHash: string | null
	discordUsername: string | null
	privileges: string[]
	tosAcceptedVersion: number
	chatEnabled: boolean
	chatBlocked: boolean
	mutedUserIds: string[]
	// Legacy (Postgres) player ids muted before the muted player had a Nakama
	// account; resolved into mutedUserIds once they log in to Nakama.
	unresolvedMutedPlayerIds: string[]
	// The players row this account was synced from, if any.
	legacyPlayerId: string | null
	// True once the Postgres sync ran (or there was nothing to sync).
	synced: boolean
	// True once the player has logged in through session_init (nakama_only).
	// Until then the API owns the account (names included), and this profile
	// only holds what Nakama's own checks need (ToS, chat consent).
	nakamaLogin: boolean
}

// What the API's player-sync route answers (apps/server/src/features/nakama/player-sync.service.ts).
export interface PlayerSync {
	playerId: string
	steamName: string
	useDiscordName: boolean
	preferredJoker: string
	discordIdHash: string | null
	discordUsername: string | null
	privileges: string[]
	tosAcceptedVersion: number
	chatEnabled: boolean
	chatBlocked: boolean
	mutedUserIds: string[]
	unresolvedMutedPlayerIds: string[]
	bans: { type: unknown; banId: unknown; expiresAt: unknown; reason: unknown }[]
}

export function cleanName(name: unknown): string {
	if (typeof name !== 'string') return ''
	return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH)
}

export function defaultProfile(steamName: string): Profile {
	return {
		steamName,
		useDiscordName: false,
		preferredJoker: DEFAULT_JOKER,
		mods: null,
		discordIdHash: null,
		discordUsername: null,
		privileges: [],
		tosAcceptedVersion: 0,
		chatEnabled: false,
		chatBlocked: false,
		mutedUserIds: [],
		unresolvedMutedPlayerIds: [],
		legacyPlayerId: null,
		synced: false,
		nakamaLogin: false,
	}
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// The stored object as a Profile, filling in anything missing (older shapes).
export function profileOf(value: { [key: string]: unknown }, fallbackName: string): Profile {
	const base = defaultProfile(cleanName(value.steamName) || fallbackName)
	return {
		...base,
		useDiscordName: value.useDiscordName === true,
		preferredJoker: typeof value.preferredJoker === 'string' ? value.preferredJoker : base.preferredJoker,
		mods: value.mods === undefined ? null : value.mods,
		discordIdHash: typeof value.discordIdHash === 'string' ? value.discordIdHash : null,
		discordUsername: typeof value.discordUsername === 'string' ? value.discordUsername : null,
		privileges: stringList(value.privileges),
		tosAcceptedVersion: typeof value.tosAcceptedVersion === 'number' ? value.tosAcceptedVersion : 0,
		chatEnabled: value.chatEnabled === true,
		chatBlocked: value.chatBlocked === true,
		mutedUserIds: stringList(value.mutedUserIds),
		unresolvedMutedPlayerIds: stringList(value.unresolvedMutedPlayerIds),
		legacyPlayerId: typeof value.legacyPlayerId === 'string' ? value.legacyPlayerId : null,
		synced: value.synced === true,
		nakamaLogin: value.nakamaLogin === true,
	}
}

// profile with the player's Postgres data applied.
export function withSync(profile: Profile, sync: PlayerSync): Profile {
	return {
		...profile,
		useDiscordName: sync.useDiscordName === true,
		preferredJoker: typeof sync.preferredJoker === 'string' ? sync.preferredJoker : profile.preferredJoker,
		discordIdHash: sync.discordIdHash ?? null,
		discordUsername: sync.discordUsername ?? null,
		privileges: stringList(sync.privileges),
		tosAcceptedVersion: typeof sync.tosAcceptedVersion === 'number' ? sync.tosAcceptedVersion : 0,
		chatEnabled: sync.chatEnabled === true,
		chatBlocked: sync.chatBlocked === true,
		mutedUserIds: stringList(sync.mutedUserIds),
		unresolvedMutedPlayerIds: stringList(sync.unresolvedMutedPlayerIds),
		legacyPlayerId: typeof sync.playerId === 'string' ? sync.playerId : null,
		synced: true,
	}
}

// The name other players see.
export function displayNameOf(profile: Profile): string {
	if (profile.useDiscordName && profile.discordUsername) return profile.discordUsername
	return profile.steamName
}

// The login response's player object, in the API's playerPayload shape.
export function playerView(userId: string, profile: Profile) {
	return {
		id: userId,
		steamName: profile.steamName,
		displayName: displayNameOf(profile),
		useDiscordName: profile.useDiscordName,
		preferredJoker: profile.preferredJoker,
		discordLinked: profile.discordIdHash !== null,
		discordUsername: profile.discordUsername,
		privileges: privilegeTable(profile.privileges),
		chatEnabled: profile.chatEnabled,
		chatBlocked: profile.chatBlocked,
		mutedPlayerIds: profile.mutedUserIds,
	}
}

export interface StoredProfile {
	profile: Profile
	version: string
}

export function readProfile(nk: nkruntime.Nakama, userId: string, fallbackName = ''): StoredProfile | null {
	const objects = nk.storageRead([{ collection: PLAYER_COLLECTION, key: PROFILE_KEY, userId }])
	if (objects.length === 0) return null
	return { profile: profileOf(objects[0].value, fallbackName), version: objects[0].version || '' }
}

// Writes profile if it is still at `version` ('*': must not exist yet).
// Throws on a version clash.
export function writeProfile(nk: nkruntime.Nakama, userId: string, profile: Profile, version?: string) {
	nk.storageWrite([
		{
			collection: PLAYER_COLLECTION,
			key: PROFILE_KEY,
			userId,
			value: profile as unknown as { [key: string]: unknown },
			version,
			permissionRead: 1,
			permissionWrite: 0,
		},
	])
}

// Applies change to the stored profile (a default one when there is none),
// retrying on a concurrent write. Returns the written profile.
export function updateProfile(
	nk: nkruntime.Nakama,
	userId: string,
	change: (profile: Profile) => Profile,
	fallbackName = '',
): Profile {
	let lastError: unknown = null
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const stored = readProfile(nk, userId, fallbackName)
		const next = change(stored ? stored.profile : defaultProfile(fallbackName))
		try {
			writeProfile(nk, userId, next, stored ? stored.version : '*')
			return next
		} catch (e) {
			lastError = e
		}
	}
	throw lastError
}

// The profile, or a default one (not stored) when the player has none yet.
export function profileFor(nk: nkruntime.Nakama, userId: string, fallbackName = ''): Profile {
	const stored = readProfile(nk, userId, fallbackName)
	return stored ? stored.profile : defaultProfile(fallbackName)
}
