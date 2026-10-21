// The retention rules the hourly purge applies to moderation evidence: an
// expired flagged message is kept while its item is open, and a reported
// lobby's chat is kept until 30 days after its last report was resolved.

export const REPORTED_CHAT_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface FlaggedMessageRetention {
	expiresAt: Date
	hasOpenItem: boolean
}

export function flaggedMessagePurgeable(row: FlaggedMessageRetention, now: Date): boolean {
	return row.expiresAt < now && !row.hasOpenItem
}

export interface ReportedLobbyRetention {
	// Open reports filed in the lobby.
	openReports: number
	// The latest resolution among its reports, null when none was resolved.
	lastResolvedAt: Date | null
	// The latest expiresAt among its kept lines (set 30 days after filing).
	latestExpiresAt: Date
}

export function reportedLobbyPurgeable(lobby: ReportedLobbyRetention, now: Date): boolean {
	if (lobby.openReports > 0) return false
	if (lobby.latestExpiresAt >= now) return false
	return lobby.lastResolvedAt === null || now.getTime() - lobby.lastResolvedAt.getTime() > REPORTED_CHAT_KEEP_MS
}
