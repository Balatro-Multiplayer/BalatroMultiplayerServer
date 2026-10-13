import { eq, max } from 'drizzle-orm'
import { db } from '../db/index.js'
import { reports, reportedLobbyMessages } from '../db/schema.js'
import type { Lobby } from '../../state/lobby.js'
import type { ReportType } from '../../shared/types/index.js'
import { getMostRecentRunForLobbyCode } from './replay-log.gateway.js'
import { enqueueServiceQueueItem } from './service-queue.gateway.js'

export type { ReportType } from '../../shared/types/index.js'

export const REPORT_TYPES: readonly ReportType[] = [
	'cheating',
	'chat_abuse',
	'griefing',
	'inappropriate_username',
	'other',
]

export function isReportType(value: unknown): value is ReportType {
	return typeof value === 'string' && REPORT_TYPES.includes(value as ReportType)
}

export async function submitReport(
	lobby: Lobby,
	reporterId: string,
	reportedId: string,
	type: ReportType,
	message: string | undefined,
): Promise<number> {
	// The actual "match" identifier (§15.6) -- reports.lobbyId is only the
	// ephemeral in-memory lobby instance, not the same id as lobbyRuns.id that
	// replay/logs are keyed by. Resolved as the most recent run for this lobby's
	// code; null if no match has started on this lobby yet.
	const runId = await getMostRecentRunForLobbyCode(lobby.code)

	// The first report flushes the in-memory message buffer to DB so the
	// history leading up to the report is preserved alongside future messages.
	const chat = lobby.isReported ? [] : lobby.messageBuffer
	const id = await recordReport({
		lobbyId: lobby.id,
		lobbyCode: lobby.code,
		reporterId,
		reportedId,
		type,
		runId,
		message,
		chat,
	})
	lobby.isReported = true
	return id
}

export interface ReportedChatLine {
	playerId: string
	displayName: string
	message: string
	sentAt: Date
}

export interface NewReport {
	lobbyId: string
	lobbyCode: string
	reporterId: string
	reportedId: string
	type: ReportType
	runId: string | null
	message: string | undefined
	chat: ReportedChatLine[]
}

/**
 * A report filed in a Nakama lobby (features/nakama). The lobby sends its
 * whole chat tail with every report, so only lines newer than those already
 * kept for the lobby are stored.
 */
export async function submitNakamaReport(report: NewReport): Promise<number> {
	const [kept] = await db
		.select({ latest: max(reportedLobbyMessages.sentAt) })
		.from(reportedLobbyMessages)
		.where(eq(reportedLobbyMessages.lobbyId, report.lobbyId))
	const latest = kept?.latest ?? null
	const chat = latest ? report.chat.filter((line) => line.sentAt > latest) : report.chat
	return recordReport({ ...report, chat })
}

async function recordReport(report: NewReport): Promise<number> {
	const [row] = await db
		.insert(reports)
		.values({
			lobbyId: report.lobbyId,
			lobbyCode: report.lobbyCode,
			reporterId: report.reporterId,
			reportedId: report.reportedId,
			type: report.type,
			runId: report.runId,
			message: report.message,
		})
		.returning({ id: reports.id })

	if (report.chat.length > 0) {
		const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		await db.insert(reportedLobbyMessages).values(
			report.chat.map((entry) => ({
				lobbyId: report.lobbyId,
				lobbyCode: report.lobbyCode,
				playerId: entry.playerId,
				displayName: entry.displayName,
				message: entry.message,
				sentAt: entry.sentAt,
				expiresAt,
			})),
		)
	}

	await enqueueServiceQueueItem({
		itemType: 'report',
		sourceId: String(row!.id),
		subjectPlayerId: report.reportedId,
		summary: `${report.type} report — lobby ${report.lobbyCode}`,
	})

	return row!.id
}

export type ReportRecord = typeof reports.$inferSelect

/** Looks up a single report by id, or null if it doesn't exist. */
export async function getReportById(id: number): Promise<ReportRecord | null> {
	const [row] = await db.select().from(reports).where(eq(reports.id, id)).limit(1)
	return row ?? null
}

/** Sets (upsert-style, last-write-wins) the submitter's follow-up detail text. */
export async function setAdditionalDetail(
	id: number,
	additionalDetail: string,
): Promise<ReportRecord | null> {
	const [row] = await db
		.update(reports)
		.set({ additionalDetail })
		.where(eq(reports.id, id))
		.returning()
	return row ?? null
}

/** Marks a report resolved (one-way, no notes). */
export async function resolveReport(id: number): Promise<ReportRecord | null> {
	const [row] = await db
		.update(reports)
		.set({ status: 'resolved' })
		.where(eq(reports.id, id))
		.returning()
	return row ?? null
}
