// session_init: the game client's login. The client calls it right after
// authenticating and gets back the player, the ToS gate and the server
// config.
// At a Steam account's first call the player's Postgres data is synced over
// through the API (player-sync); if that fails the login still succeeds and
// the sync is tried again next time.
import { noteReturn } from '../lobby/forfeits'
import { clientConfig, readConfig, type ServerConfig } from '../config'
import { callExpress } from '../express'
import { UNVERIFIED, writeIntegrity } from '../integrity'
import { PERMISSION_DENIED, runtimeError } from '../errors'
import { ACCOUNT_BANNED, banMessage } from '../moderation/access'
import { activeBan, bansFromList, readBans, withBan, writeBans, BAN_TYPES } from '../moderation/bans'
import { enforceAccountBan } from '../moderation/enforce'
import { parsePayload, requireUser } from '../rpc'
import {
	cleanName,
	displayNameOf,
	playerView,
	readProfile,
	updateProfile,
	withSync,
	type PlayerSync,
	type Profile,
} from './profile'

const STEAM_CUSTOM_ID = /^steam:(\d+)$/

export function steamIdOf(nk: nkruntime.Nakama, userId: string): string | null {
	const match = STEAM_CUSTOM_ID.exec(nk.accountGetId(userId).customId || '')
	return match ? match[1] : null
}

function isPlayerSync(value: { [key: string]: unknown }): boolean {
	return typeof value.playerId === 'string' && Array.isArray(value.bans)
}

// The player's Postgres data, or null when the API can't be reached.
function fetchSync(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	userId: string,
	steamId: string,
	steamName: string,
): PlayerSync | null {
	const reply = callExpress(nk, logger, ctx.env, '/player-sync', { steamId, nakamaUserId: userId, steamName })
	if (!reply || reply.status !== 200 || !isPlayerSync(reply.body)) {
		logger.warn('Player sync for %s failed (HTTP %v); retrying next login', userId, reply && reply.status)
		return null
	}
	return reply.body as unknown as PlayerSync
}

// Legacy mutes of players who have logged in to Nakama since.
function resolveMutes(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	profile: Profile,
): { [playerId: string]: string } {
	const reply = callExpress(nk, logger, ctx.env, '/resolve-players', { playerIds: profile.unresolvedMutedPlayerIds })
	const resolved = reply && reply.status === 200 ? reply.body.resolved : null
	return resolved && typeof resolved === 'object' ? (resolved as { [playerId: string]: string }) : {}
}

export function withResolvedMutes(profile: Profile, resolved: { [playerId: string]: string }): Profile {
	const found = profile.unresolvedMutedPlayerIds.filter((id) => typeof resolved[id] === 'string')
	if (found.length === 0) return profile
	const muted = profile.mutedUserIds.slice()
	for (const id of found) if (muted.indexOf(resolved[id]) === -1) muted.push(resolved[id])
	return {
		...profile,
		mutedUserIds: muted,
		unresolvedMutedPlayerIds: profile.unresolvedMutedPlayerIds.filter((id) => found.indexOf(id) === -1),
	}
}

// The login response: the API's gameLoginPayload, minus its tokens (the
// client already holds a Nakama session).
export function loginResponse(userId: string, profile: Profile, config: ServerConfig) {
	const tosRequired = profile.tosAcceptedVersion < config.tosVersion
	return {
		tosRequired,
		// An update to a ToS the player accepted before (only with tosRequired).
		tosUpdate: tosRequired && profile.tosAcceptedVersion > 0,
		player: playerView(userId, profile),
		serverConfig: clientConfig(config),
	}
}

// Keeps the Nakama account's display name (shown by Nakama itself, e.g. in
// presences and the matchmaker) in step with the profile.
export function syncDisplayName(nk: nkruntime.Nakama, userId: string, profile: Profile) {
	const name = displayNameOf(profile)
	if (nk.accountGetId(userId).user.displayName !== name)
		nk.accountUpdateId(userId, null, name, null, null, null, null, null)
}

// {steamName} -> loginResponse.
export function rpcSessionInit(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	noteReturn(nk, logger, userId, Date.now())
	const steamName = cleanName(parsePayload(payload).steamName) || ctx.username
	const stored = readProfile(nk, userId, steamName)
	const steamId = steamIdOf(nk, userId)

	let sync: PlayerSync | null = null
	let resolved: { [playerId: string]: string } = {}
	if (!stored || !stored.profile.synced) {
		if (steamId) sync = fetchSync(ctx, logger, nk, userId, steamId, steamName)
	} else if (stored.profile.unresolvedMutedPlayerIds.length > 0) {
		resolved = resolveMutes(ctx, logger, nk, stored.profile)
	}

	const profile = updateProfile(
		nk,
		userId,
		(current) => {
			let next: Profile = { ...current, steamName, nakamaLogin: true }
			if (sync) next = withSync(next, sync)
			else if (!steamId) next.synced = true // device login: nothing to sync
			return withResolvedMutes(next, resolved)
		},
		steamName,
	)
	if (sync) {
		let bans = readBans(nk, userId)
		const synced = bansFromList(sync.bans)
		for (const type of BAN_TYPES) {
			const ban = synced[type]
			if (ban) bans = withBan(bans, type, ban)
		}
		writeBans(nk, userId, bans)
		logger.info('Synced player %s from Postgres player %s', userId, sync.playerId)
	}
	// An account ban the sync brought over (or one Nakama's own ban somehow
	// missed) ends the login here.
	const accountBan = activeBan(readBans(nk, userId), 'account', Date.now())
	if (accountBan) {
		enforceAccountBan(nk, userId, accountBan)
		throw runtimeError(PERMISSION_DENIED, banMessage(ACCOUNT_BANNED, accountBan))
	}
	syncDisplayName(nk, userId, profile)
	// A new login is unverified until launcher_session_start's challenge passes.
	writeIntegrity(nk, userId, UNVERIFIED)
	return JSON.stringify(loginResponse(userId, profile, readConfig(nk)))
}

// {chatEligible?} -> loginResponse. Accepts the current ToS version; with
// chatEligible (worked out client-side from the birthdate, never sent raw)
// also turns chat on or blocks it, as the API's acceptTos does.
export function rpcTosAccept(
	ctx: nkruntime.Context,
	logger: nkruntime.Logger,
	nk: nkruntime.Nakama,
	payload: string,
) {
	const userId = requireUser(ctx)
	const eligible = parsePayload(payload).chatEligible
	const config = readConfig(nk)
	const profile = updateProfile(
		nk,
		userId,
		(current) => {
			const next: Profile = { ...current, tosAcceptedVersion: config.tosVersion }
			if (typeof eligible === 'boolean') {
				next.chatEnabled = eligible
				next.chatBlocked = !eligible
			}
			return next
		},
		ctx.username,
	)
	return JSON.stringify(loginResponse(userId, profile, config))
}
