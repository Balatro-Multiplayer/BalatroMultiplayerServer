// What a client says it has installed: MPAPI.collect_installed_mods() sends
// each enabled SMODS mod as "<SMODS id>-<version>" through profile_set_mods.
// Pure: parsing an entry and checking a report against the allowed ids.

// A report as stored for the current session (storage.ts).
export interface ModReport {
	mods: string[]
	reportedAt: number
}

export interface ReportedMod {
	key: string
	version: string
}

// Where an entry's version starts: the first '-' followed by something that
// reads as a version (a digit, '~', 'v1', or MPAPI's 'UNK' for a mod without
// one). Both halves may hold hyphens -- "Steamodded-1.0.0~BETA-1814a" -- so
// neither the first nor the last '-' is right on its own; with no
// version-looking part the last '-' splits it.
const VERSION_START = /-(?=[0-9~]|v[0-9]|UNK$)/

export function parseReportedMod(entry: string): ReportedMod {
	const match = VERSION_START.exec(entry)
	const at = match ? match.index : entry.lastIndexOf('-')
	if (at <= 0) return { key: entry, version: '' }
	return { key: entry.slice(0, at), version: entry.slice(at + 1) }
}

// Whether an entry names one of the allowed ids, by id only, case-sensitive
// like SMODS: "<id>-<anything>", or the bare id.
function isAllowedEntry(entry: string, allowedIds: string[]): boolean {
	return allowedIds.some((id) => entry === id || entry.indexOf(id + '-') === 0)
}

// The reported mods that aren't allowed, by key, each once, in report order.
export function disallowedMods(reported: string[], allowedIds: string[]): string[] {
	const out: string[] = []
	for (const entry of reported) {
		if (isAllowedEntry(entry, allowedIds)) continue
		const key = parseReportedMod(entry).key
		if (out.indexOf(key) === -1) out.push(key)
	}
	return out
}
