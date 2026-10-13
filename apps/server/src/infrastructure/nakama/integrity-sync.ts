import type { IntegrityVerdict } from '../../features/launcher-integrity/launcher-integrity.service.js'
import { callNakamaRpc } from './admin-client.js'

// A launcher-integrity verdict for a Nakama user (nakama/src/integrity.ts),
// which gates Nakama's ranked queue on it.
export async function setNakamaIntegrity(
	nakamaUserId: string,
	verdict: IntegrityVerdict,
): Promise<void> {
	const result = await callNakamaRpc('admin_integrity_set', {
		userId: nakamaUserId,
		...verdict,
	})
	if (!result.ok)
		console.warn(
			`[nakama] Integrity verdict for ${nakamaUserId} not set: ${result.error}`,
		)
}
