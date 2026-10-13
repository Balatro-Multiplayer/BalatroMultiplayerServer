// Account changes made on the website and webadmin (the BMP API), applied to
// the player's Nakama profile so the game sees them at once: privileges,
// display name and joker preferences, a Discord unlink, and account deletion.
// Server only. (Linking Discord is admin_discord_set, in discord.ts.)
import { FAILED_PRECONDITION, INVALID_ARGUMENT, NOT_FOUND, runtimeError } from '../errors'
import { currentLobby } from '../lobby/rpc'
import type { LobbySignal } from '../lobby/protocol'
import { parsePayload, requireServer } from '../rpc'
import { isValidJoker } from '../shared/jokers'
import { releaseDiscord, withoutDiscord } from './discord'
import { playerView, profileFor, updateProfile, type Profile } from './profile'
import { profileChanged } from './rpc'

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIVILEGE = /^[a-z0-9_-]{1,64}$/i

export interface ProfileEdit {
	privileges?: string[]
	useDiscordName?: boolean
	preferredJoker?: string
	// null unlinks.
	discord?: null
}

function requireAccount(nk: nkruntime.Nakama, userId: unknown): string {
	if (typeof userId !== 'string' || !USER_ID.test(userId)) throw runtimeError(INVALID_ARGUMENT, 'userId is required')
	try {
		nk.accountGetId(userId)
	} catch (e) {
		throw runtimeError(NOT_FOUND, 'No such user')
	}
	return userId
}

// The edit in a request body; INVALID_ARGUMENT for a field of the wrong shape.
export function parseEdit(input: { [key: string]: unknown }): ProfileEdit {
	const edit: ProfileEdit = {}
	const { privileges, useDiscordName, preferredJoker, discord } = input
	if (privileges !== undefined) {
		if (!Array.isArray(privileges) || !privileges.every((p) => typeof p === 'string' && PRIVILEGE.test(p)))
			throw runtimeError(INVALID_ARGUMENT, 'privileges must be an array of privilege names')
		edit.privileges = privileges as string[]
	}
	if (useDiscordName !== undefined) {
		if (typeof useDiscordName !== 'boolean') throw runtimeError(INVALID_ARGUMENT, 'useDiscordName must be a boolean')
		edit.useDiscordName = useDiscordName
	}
	if (preferredJoker !== undefined) {
		if (typeof preferredJoker !== 'string' || !preferredJoker)
			throw runtimeError(INVALID_ARGUMENT, 'preferredJoker must be a joker id')
		edit.preferredJoker = preferredJoker
	}
	if (discord !== undefined) {
		if (discord !== null) throw runtimeError(INVALID_ARGUMENT, 'discord can only be null (unlink)')
		edit.discord = null
	}
	return edit
}

// Pure: profile with edit applied, checked as the player's own RPCs check it
// (a Discord name needs a linked Discord, a joker needs its privilege).
export function applyEdit(profile: Profile, edit: ProfileEdit): Profile {
	let next = { ...profile }
	if (edit.privileges !== undefined) next.privileges = edit.privileges
	if (edit.discord === null) next = withoutDiscord(next)
	if (edit.useDiscordName !== undefined) {
		if (edit.useDiscordName && !next.discordIdHash) throw runtimeError(FAILED_PRECONDITION, 'Discord account not linked')
		next.useDiscordName = edit.useDiscordName
	}
	if (edit.preferredJoker !== undefined) {
		if (!isValidJoker(edit.preferredJoker, next.privileges)) throw runtimeError(INVALID_ARGUMENT, 'Invalid joker')
		next.preferredJoker = edit.preferredJoker
	}
	return next
}

// {userId, privileges?, useDiscordName?, preferredJoker?, discord?: null} -> {player}
export function rpcAdminProfileSet(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const input = parsePayload(payload)
	const userId = requireAccount(nk, input.userId)
	const edit = parseEdit(input)
	let previousDiscord: string | null = null
	const profile = updateProfile(nk, userId, (current) => {
		previousDiscord = current.discordIdHash
		return applyEdit(current, edit)
	})
	if (edit.discord === null) releaseDiscord(nk, userId, previousDiscord)
	profileChanged(nk, userId, profile)
	logger.info('Profile of %s updated by the API: %v', userId, JSON.stringify(Object.keys(edit)))
	return JSON.stringify({ player: playerView(userId, profile) })
}

// {userId} -> {deleted: true}: the account deleted from the website. The
// player leaves their lobby, and the account and everything it owns is
// deleted. Its session tokens are revoked first ('' tokens: all of them). Bans outlive it: they are indexed by login
// id (moderation/enforce.ts) and kept in Postgres, which a new account for
// the same Steam id syncs from.
export function rpcAdminAccountDelete(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	requireServer(ctx)
	const userId = requireAccount(nk, parsePayload(payload).userId)
	const lobby = currentLobby(nk, userId)
	if (lobby) {
		const signal: LobbySignal = { type: 'admin_remove', userId, reason: 'account_deleted', onlyIfStarted: false }
		nk.matchSignal(lobby.matchId, JSON.stringify(signal))
	}
	releaseDiscord(nk, userId, profileFor(nk, userId).discordIdHash)
	nk.sessionLogout(userId, '', '')
	nk.accountDeleteId(userId, false)
	logger.info('Deleted account %s', userId)
	return JSON.stringify({ deleted: true })
}
