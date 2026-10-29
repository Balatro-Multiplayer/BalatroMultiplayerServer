import { env } from '../../env.js'
import { findPlayerById } from '../../infrastructure/gateways/player.gateway.js'
import { AppError } from './errors.js'

// The owner is the admin whose player id is OWNER_PLAYER_ID. With no id set
// nobody is the owner.
export function isOwner(playerId: string, privileges: readonly string[]): boolean {
	return (
		env.OWNER_PLAYER_ID !== '' &&
		playerId === env.OWNER_PLAYER_ID &&
		privileges.includes('admin')
	)
}

export async function requireOwner(req: import('express').Request): Promise<void> {
	const playerId = req.player!.playerId
	const player = await findPlayerById(playerId)
	if (!isOwner(playerId, player?.privileges ?? [])) {
		throw new AppError('Owner privileges required', 403)
	}
}
