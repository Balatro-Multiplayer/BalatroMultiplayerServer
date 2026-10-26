// Accounts are named by a peppered hash of the Steam id (ADR 0004): the raw
// id lives only in memory during the login before-hooks. The hash is
// sha256(steamId + PLAYER_ID_SALT) in hex, the same function the API uses
// (hashProviderId), so it is also the Postgres player's steamIdHash.
//
// Steam login: custom id "steamhash:<hash>". Device login with a SteamID64
// (Community and Dev servers): device id "devicehash:<hash>". Accounts made
// before this were "steam:<raw id>" (moved by the API's
// rewrite-steam-ids script) and raw SteamID64 device ids (moved at their
// next login, auth.ts).

export const STEAM_HASH_CUSTOM_ID_PREFIX = 'steamhash:'
export const STEAM_HASH_DEVICE_ID_PREFIX = 'devicehash:'
export const STEAM_ID64_PATTERN = /^7656119\d{10}$/
const STEAM_HASH_CUSTOM_ID = /^steamhash:([0-9a-f]{64})$/

export function steamIdHash(
	nk: nkruntime.Nakama,
	salt: string,
	steamId: string,
): string {
	return nk.sha256Hash(steamId + salt)
}

// The Steam id hash an account is named by, or null for an account with no
// Steam login (a Device login account).
export function steamIdHashOf(
	nk: nkruntime.Nakama,
	userId: string,
): string | null {
	const match = STEAM_HASH_CUSTOM_ID.exec(
		nk.accountGetId(userId).customId || '',
	)
	return match ? match[1] : null
}
