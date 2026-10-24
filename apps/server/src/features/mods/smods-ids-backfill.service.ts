import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
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
	// Pins that already had ids, were already read for their version (and
	// declare none, like Steamodded and Lovely), or have no permanent
	// download to read them from.
	skipped: number
}

// Reads the SMODS ids of every ranked pin that has none yet and was not read
// for its version (pinned before migration 0051) from its permanent
// download, laid out as deployed. Never touches the pin or its hash, and
// leaves ids an admin set alone.
export async function backfillSmodsIds(): Promise<SmodsIdsBackfillSummary> {
	const summary: SmodsIdsBackfillSummary = { read: 0, failed: 0, skipped: 0 }
	for (const pin of await listRankedPins()) {
		const read =
			pin.smodsIds.length > 0 || pin.smodsIdsReadVersion === pin.rankedVersion
		if (read || !pin.rankedDownloadUrl || !pin.rankedSource) {
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
			console.warn(
				`[smods-ids] Could not read the SMODS ids of ${pin.id}@${version}; it stays out of the allowed-mod set until a later read`,
			)
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

// Run at API boot: fills the SMODS ids any pin is missing, then pushes the
// new allowed-mod set to Nakama if anything was read. A pin change reads its
// ids itself (mods.gateway.ts's setRankedVersion). Never throws, so a dead
// download or a database error cannot fail the boot.
export async function fillMissingSmodsIds(): Promise<void> {
	try {
		const summary = await backfillSmodsIds()
		if (summary.read > 0) await loadConfigFromDb()
	} catch (err) {
		console.warn('[smods-ids] Automatic backfill failed:', err)
	}
}
