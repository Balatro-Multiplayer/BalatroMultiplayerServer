import {
	listRankedPins,
	storePinFileHashes,
} from '../../infrastructure/gateways/mods.gateway.js'
import { type ModLayout, inspectModRelease } from './mod-version-hash.js'

export interface FileHashesBackfillSummary {
	read: number
	failed: number
	skipped: number
}

// Lovely is the only pin the launcher checks by file hash (it deploys one
// file next to the game instead of a hashed Mods folder), so only it is
// backfilled -- reading every pin would re-download every ranked mod.
function wantsFileHashes(id: string): boolean {
	return /lovely/i.test(id)
}

// Reads the injector-file hashes of every Lovely pin that has none yet (pinned
// before migration 0077) from its permanent download. Never touches the pin,
// its folder hash or its SMODS ids. A pin made from now on gets them when it
// is pinned (mods.gateway.ts's storeRankedPin).
export async function backfillRankedFileHashes(): Promise<FileHashesBackfillSummary> {
	const summary: FileHashesBackfillSummary = { read: 0, failed: 0, skipped: 0 }
	for (const pin of await listRankedPins()) {
		const version = pin.rankedVersion
		if (
			!version ||
			!wantsFileHashes(pin.id) ||
			pin.rankedFileHashes !== null ||
			!pin.rankedDownloadUrl ||
			!pin.rankedSource
		) {
			summary.skipped++
			continue
		}
		const inspected = await inspectModRelease(
			pin.id,
			version,
			pin.rankedDownloadUrl,
			pin.rankedSource as ModLayout,
		)
		if (!inspected) {
			console.warn(
				`[file-hashes] Could not read the injector files of ${pin.id}@${version}; the launcher falls back to its own table until a later read`,
			)
			summary.failed++
			continue
		}
		if (inspected.hash !== pin.rankedVersionSha256) {
			console.warn(
				`[file-hashes] The download of ${pin.id}@${version} no longer matches the pinned hash; not storing its injector file hashes`,
			)
			summary.failed++
			continue
		}
		await storePinFileHashes(pin.id, version, inspected.fileHashes)
		summary.read++
	}
	console.log(
		`[file-hashes] Backfill: ${summary.read} read, ${summary.failed} failed, ${summary.skipped} skipped`,
	)
	return summary
}

// Run at API boot. Never throws, so a dead download or a database error cannot
// fail the boot.
export async function fillMissingRankedFileHashes(): Promise<void> {
	try {
		await backfillRankedFileHashes()
	} catch (err) {
		console.warn('[file-hashes] Automatic backfill failed:', err)
	}
}
