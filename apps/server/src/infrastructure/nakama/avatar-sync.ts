import { findPlayerById } from '../gateways/player.gateway.js'
import { err, ok } from '../../shared/utils/result.js'
import type { Result } from '../../shared/utils/result.js'
import { callNakamaRpc, isNakamaAdminEnabled } from './admin-client.js'
import type { NakamaRpcError } from './admin-client.js'

// Avatars (preferred jokers) are Nakama's: it holds the catalog, what each
// player has earned, and the rules for picking one (nakama/src/achievements,
// nakama/src/shared/avatars). The API asks it rather than keeping a copy.

export interface AvatarGoal {
	kind: string
	key: string
	threshold: number
	progress: number
}

// admin_avatars_for's answer (nakama/src/achievements/rpc.ts).
export interface AvatarCatalog {
	avatars: { id: string; unlocked: boolean; goal: AvatarGoal | null }[]
	selected: string
	// Whether games count toward goals right now (achievementsEnabled).
	enabled: boolean
	// The ids the player may pick.
	jokers: string[]
}

// unavailable: Nakama is off or didn't answer; refused: not a joker this player may pick.
export type AvatarError = 'unavailable' | 'refused'

const unavailableOr = (error: NakamaRpcError, otherwise: AvatarError): AvatarError =>
	error === 'disabled' || error === 'unreachable' ? 'unavailable' : otherwise

async function accountOf(playerId: string): Promise<{ userId: string | null; privileges: string[] }> {
	const player = await findPlayerById(playerId)
	return { userId: player?.nakamaUserId ?? null, privileges: player?.privileges ?? [] }
}

// A player who never signed in to Nakama is answered from their privileges
// alone (nothing earned yet).
export async function avatarsFor(playerId: string): Promise<Result<AvatarCatalog, 'unavailable'>> {
	if (!isNakamaAdminEnabled()) return err('unavailable')
	const { userId, privileges } = await accountOf(playerId)
	const result = await callNakamaRpc<AvatarCatalog>('admin_avatars_for', userId ? { userId } : { privileges })
	return result.ok ? result : err('unavailable')
}

// Sets the player's avatar in Nakama, which refuses one they may not pick.
// The caller writes Postgres only after this succeeds, so the two never
// disagree on a joker Nakama would refuse.
export async function setNakamaAvatar(playerId: string, preferredJoker: string): Promise<Result<void, AvatarError>> {
	if (!isNakamaAdminEnabled()) return err('unavailable')
	const { userId } = await accountOf(playerId)
	if (!userId) {
		// Nothing in Nakama to update: check the pick against the catalog only.
		const catalog = await avatarsFor(playerId)
		if (!catalog.ok) return catalog
		return catalog.value.jokers.includes(preferredJoker) ? ok(undefined) : err('refused')
	}
	const result = await callNakamaRpc('admin_profile_set', { userId, preferredJoker })
	return result.ok ? ok(undefined) : err(unavailableOr(result.error, 'refused'))
}
