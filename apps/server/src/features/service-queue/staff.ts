import type { Request } from 'express'
import { findPlayerById } from '../../infrastructure/gateways/player.gateway.js'
import type { Staff } from './dispatcher.js'
import { roleOf } from './types.js'

// The signed-in staff member and their role, or null for anyone else (the
// webadmin router has already refused non-staff; this reads the role).
export async function staffOf(req: Request): Promise<Staff | null> {
	const player = req.player ? await findPlayerById(req.player.playerId) : null
	const role = player ? roleOf(player.privileges) : null
	return player && role ? { playerId: player.id, role } : null
}
