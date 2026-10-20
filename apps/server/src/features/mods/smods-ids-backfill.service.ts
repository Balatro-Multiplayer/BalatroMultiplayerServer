import {
	listRankedPins,
	storePinSmodsIds,
} from '../../infrastructure/gateways/mods.gateway.js'
import { type ModLayout, inspectModRelease } from './mod-version-hash.js'

export interface SmodsIdsBackfillSummary {
	// Pins whose ids were read and stored (possibly still none).
	read: number
	// Pins whose download couldn't be fetched or extracted right now.
	failed: number
	// Pins that already had ids, or no permanent download to read them from.
	skipped: number
}

// Reads the SMODS ids of every ranked pin that has none yet (pinned before
// migration 0051) from its permanent download, laid out as deployed. Never
// touches the pin or its hash, and leaves ids an admin set alone.
export async function backfillSmodsIds(): Promise<SmodsIdsBackfillSummary> {
	const summary: SmodsIdsBackfillSummary = { read: 0, failed: 0, skipped: 0 }
	for (const pin of await listRankedPins()) {
		if (pin.smodsIds.length > 0 || !pin.rankedDownloadUrl || !pin.rankedSource) {
			summary.skipped++
			continue
		}
		const version = pin.rankedVersion!
		const inspected = await inspectModRelease(
			pin.id,
			version,
			pin.rankedDownloadUrl,
			pin.rankedSource as ModLayout,
		)
		if (!inspected) {
			summary.failed++
			continue
		}
		await storePinSmodsIds(pin.id, version, inspected.smodsIds)
		summary.read++
	}
	console.log(
		`[smods-ids] Backfill: ${summary.read} read, ${summary.failed} failed, ${summary.skipped} skipped`,
	)
	return summary
}
