// Players in one PvP game must run the same PvP version (X.Y.Z), because the
// versions read scores differently. The version comes from the mod report the
// server stores for the session (mod_report.ts), never from the client's join
// metadata. Pure.
import { parseReportedMod } from './mod_report'

export const PVP_MOD_ID = 'MultiplayerPvP'

export const VERSION_MISMATCH = 'version_mismatch'
export const VERSION_MISMATCH_MESSAGE = 'Everyone in a PvP game needs the same MultiplayerPvP version. Update the mod and try again.'
export const UPDATE_REQUIRED = 'update_required'
export const UPDATE_REQUIRED_MESSAGE = 'Your MultiplayerPvP version is too old to play. Update the mod and try again.'

const X_Y_Z = /^v?(\d+\.\d+\.\d+)/

// The X.Y.Z of the reported PvP entry; '' when PvP is not reported. A version
// that has no X.Y.Z (MPAPI's 'UNK') stays as reported.
export function pvpVersionOf(reported: string[]): string {
	for (const entry of reported) {
		const mod = parseReportedMod(entry)
		if (mod.key !== PVP_MOD_ID) continue
		const match = X_Y_Z.exec(mod.version)
		return match ? match[1] : mod.version
	}
	return ''
}

// -1, 0 or 1 by numeric X.Y.Z parts; text that is not X.Y.Z sorts lowest.
function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number)
	const pb = b.split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		const x = pa[i] > 0 ? pa[i] : 0
		const y = pb[i] > 0 ? pb[i] : 0
		if (x !== y) return x < y ? -1 : 1
	}
	return 0
}

const WHOLE_VERSION = /^\d+\.\d+\.\d+$/

// True when the reported X.Y.Z is lower than the minimum. No minimum ('') lets
// everyone in; an unknown version (undefined: no seat or no report) and one that is
// not X.Y.Z ('UNK') are below any minimum. A minimum that is not X.Y.Z is no minimum (config accepts only X.Y.Z).
export function belowMinimum(
	version: string | undefined,
	minimum: string,
): boolean {
	if (!WHOLE_VERSION.test(minimum)) return false
	if (version === undefined || !WHOLE_VERSION.test(version)) return true
	return compareVersions(version, minimum) < 0
}

// Who is off the version most players run (the newer version wins a tie), in
// the order given. Empty when all agree.
export function versionOutliers(versionByPlayer: { [userId: string]: string }): string[] {
	const ids = Object.keys(versionByPlayer)
	const counts: { [version: string]: number } = {}
	for (const id of ids) counts[versionByPlayer[id]] = (counts[versionByPlayer[id]] || 0) + 1
	let kept = ''
	let keptCount = 0
	for (const version of Object.keys(counts)) {
		const better =
			counts[version] > keptCount || (counts[version] === keptCount && compareVersions(version, kept) > 0)
		if (better) {
			kept = version
			keptCount = counts[version]
		}
	}
	return ids.filter((id) => versionByPlayer[id] !== kept)
}

// True when the server referees a lobby's PvP: a rules version is set and every player
// reported at least that version. No rules version, no players, or a player with an
// unknown version keeps it with the players.
export function everyoneOnServerRules(
	rulesVersion: string | undefined,
	versions: (string | undefined)[],
): boolean {
	if (rulesVersion === undefined || !WHOLE_VERSION.test(rulesVersion)) return false
	return versions.length > 0 && versions.every((version) => !belowMinimum(version, rulesVersion))
}
