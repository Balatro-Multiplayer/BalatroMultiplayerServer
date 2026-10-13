import type { IntegrityVerdict } from '../../features/launcher-integrity/launcher-integrity.service.js'
import { findPlayerById } from '../gateways/player.gateway.js'
import { callNakamaRpc, isNakamaAdminEnabled } from './admin-client.js'

// A launcher-integrity verdict for a Nakama user (nakama/src/integrity.ts),
// which gates Nakama's ranked queue on it.
export async function setNakamaIntegrity(nakamaUserId: string, verdict: IntegrityVerdict): Promise<void> {
	const result = await callNakamaRpc('admin_integrity_set', { userId: nakamaUserId, ...verdict })
	if (!result.ok) console.warn(`[nakama] Integrity verdict for ${nakamaUserId} not set: ${result.error}`)
}

// The MQTT path's verdicts, for a player who also has a Nakama account: a
// client on MQTT that queues through Nakama is gated there too.
export async function mirrorIntegrityToNakama(playerId: string, verdict: IntegrityVerdict): Promise<void> {
	if (!isNakamaAdminEnabled()) return
	const player = await findPlayerById(playerId)
	if (player?.nakamaUserId) await setNakamaIntegrity(player.nakamaUserId, verdict)
}
