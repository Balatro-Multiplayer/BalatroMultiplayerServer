// Who may play, as pure checks over the server config, the player's
// privileges and bans: the API's shared/utils/access.ts gates plus its ban
// checks. Each returns why the action is refused, or null.
import type { ServerConfig } from '../config'
import { activeBan, type Ban, type Bans } from './bans'

// Testing mode: only 'tester'-privileged players may create lobbies or queue.
export function playRefusal(config: ServerConfig, privileges: string[]): string | null {
	if (config.testingMode && privileges.indexOf('tester') === -1)
		return 'The server is in testing mode. Tester access is required to play.'
	return null
}

export function lobbyCreateRefusal(config: ServerConfig, privileges: string[]): string | null {
	if (!config.lobbyCreationEnabled) return 'Lobby creation is currently disabled.'
	return playRefusal(config, privileges)
}

export function queueRefusal(
	config: ServerConfig,
	privileges: string[],
	bans: Bans,
	ranked: boolean,
	now: number,
): string | null {
	if (ranked && !config.rankedEnabled) return 'Ranked matchmaking is currently disabled.'
	if (!ranked && !config.casualQueueEnabled) return 'Casual matchmaking is currently disabled.'
	const ban = activeBan(bans, 'queue', now)
	if (ban) return banMessage('You are banned from matchmaking', ban)
	return playRefusal(config, privileges)
}

export function chatBanRefusal(bans: Bans, now: number): string | null {
	const ban = activeBan(bans, 'chat', now)
	return ban ? banMessage('You are banned from chat', ban) : null
}

// "<what> until <ISO time>: <reason>", the parts there are. Account-ban login
// refusals start with "Account banned", which the client shows as a ban.
export function banMessage(what: string, ban: Ban): string {
	let text = what
	if (ban.expiresAt !== null) text += ' until ' + new Date(ban.expiresAt).toISOString()
	if (ban.reason) text += ': ' + ban.reason
	return text
}

export const ACCOUNT_BANNED = 'Account banned'

// A network-ban login refusal (moderation/network.ts). It never names the
// account that caused the ban. The appeal contact is the Notice's.
export const NETWORK_BANNED = 'Your network is banned from online play.'
export const NETWORK_BAN_MESSAGE = NETWORK_BANNED + ' To appeal, email bmp@virtualized.dev'
