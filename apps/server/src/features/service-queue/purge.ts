// The retention rule the hourly purge applies to a reported lobby's chat. It
// is evidence (features/retention/limits.ts): kept while a report about the
// lobby is open, then 180 days after its last report was resolved.
import { EVIDENCE_KEEP_MS } from '../retention/limits.js'

export const REPORTED_CHAT_KEEP_MS = EVIDENCE_KEEP_MS

export interface ReportedLobbyRetention {
	// Open reports filed in the lobby.
	openReports: number
	// The latest resolution among its reports, null when none was resolved.
	lastResolvedAt: Date | null
	// The latest expiresAt among its kept lines (set REPORTED_CHAT_KEEP_MS after filing).
	latestExpiresAt: Date
}

export function reportedLobbyPurgeable(lobby: ReportedLobbyRetention, now: Date): boolean {
	if (lobby.openReports > 0) return false
	if (lobby.latestExpiresAt >= now) return false
	return lobby.lastResolvedAt === null || now.getTime() - lobby.lastResolvedAt.getTime() > REPORTED_CHAT_KEEP_MS
}
