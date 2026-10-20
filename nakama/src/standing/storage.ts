// The current session's mod report: one system-written object per player,
// written by profile_set_mods and deleted by session_init, so a report always
// belongs to the session that sent it (an old client that never reports is
// unreported, not carrying the last session's list).
import type { ModReport } from './mod_report'

export const MOD_REPORT_COLLECTION = 'mod_report'
export const MOD_REPORT_KEY = 'current'
const LIST_PAGE = 100

export function readModReport(nk: nkruntime.Nakama, userId: string): ModReport | null {
	const objects = nk.storageRead([{ collection: MOD_REPORT_COLLECTION, key: MOD_REPORT_KEY, userId }])
	return objects.length > 0 ? reportOf(objects[0].value) : null
}

function reportOf(value: { [key: string]: unknown }): ModReport | null {
	const mods = value.mods
	if (!Array.isArray(mods) || !mods.every((m) => typeof m === 'string')) return null
	return { mods: mods as string[], reportedAt: typeof value.reportedAt === 'number' ? value.reportedAt : 0 }
}

export function writeModReport(nk: nkruntime.Nakama, userId: string, report: ModReport) {
	nk.storageWrite([
		{
			collection: MOD_REPORT_COLLECTION,
			key: MOD_REPORT_KEY,
			userId,
			value: report as unknown as { [key: string]: unknown },
			permissionRead: 0,
			permissionWrite: 0,
		},
	])
}

export function clearModReport(nk: nkruntime.Nakama, userId: string) {
	nk.storageDelete([{ collection: MOD_REPORT_COLLECTION, key: MOD_REPORT_KEY, userId }])
}

// Everyone holding a report: the players who reported since their last
// session_init, online or not.
export function reporterIds(nk: nkruntime.Nakama): string[] {
	const ids: string[] = []
	let cursor = ''
	do {
		const page = nk.storageList(null, MOD_REPORT_COLLECTION, LIST_PAGE, cursor)
		for (const o of page.objects || []) if (o.key === MOD_REPORT_KEY) ids.push(o.userId)
		cursor = page.cursor || ''
	} while (cursor)
	return ids
}
