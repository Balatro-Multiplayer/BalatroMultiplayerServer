import type { NewReport } from '../../infrastructure/gateways/report.gateway.js'
import { isReportType } from '../../infrastructure/gateways/report.gateway.js'
import type { ReportType } from '../../shared/types/index.js'

// A report filed in a Nakama lobby (nakama/src/moderation/report.ts). Players
// are Nakama user ids; they are stored as the matching player ids, or as the
// Nakama id for someone with no player row yet.
export interface NakamaReport {
	reporterId: string
	reportedId: string
	type: ReportType
	message: string | undefined
	lobbyId: string
	lobbyCode: string
	runId: string | null
	chat: { playerId: string; displayName: string; message: string; sentAt: number }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOBBY_CODE = /^[A-Z0-9]{1,6}$/i
const MAX_MESSAGE = 500
const MAX_CHAT_LINES = 100

function isChatLine(line: unknown): line is NakamaReport['chat'][number] {
	if (!line || typeof line !== 'object') return false
	const l = line as { [key: string]: unknown }
	return (
		typeof l.playerId === 'string' &&
		typeof l.displayName === 'string' &&
		typeof l.message === 'string' &&
		typeof l.sentAt === 'number' &&
		Number.isFinite(l.sentAt)
	)
}

// The request body as a report, or why it isn't one.
export function parseNakamaReport(body: unknown): NakamaReport | string {
	if (!body || typeof body !== 'object') return 'Missing body'
	const b = body as { [key: string]: unknown }
	if (typeof b.reporterId !== 'string' || !UUID.test(b.reporterId)) return 'Bad reporterId'
	if (typeof b.reportedId !== 'string' || !UUID.test(b.reportedId)) return 'Bad reportedId'
	if (!isReportType(b.type)) return 'Invalid report type'
	if (b.message !== undefined && b.message !== null && (typeof b.message !== 'string' || b.message.length > MAX_MESSAGE))
		return 'Invalid message (max 500 characters)'
	if (typeof b.lobbyId !== 'string' || !UUID.test(b.lobbyId)) return 'Bad lobbyId'
	if (typeof b.lobbyCode !== 'string' || !LOBBY_CODE.test(b.lobbyCode)) return 'Bad lobbyCode'
	if (b.runId !== undefined && b.runId !== null && (typeof b.runId !== 'string' || !UUID.test(b.runId)))
		return 'Bad runId'
	const chat = b.chat ?? []
	if (!Array.isArray(chat) || chat.length > MAX_CHAT_LINES || !chat.every(isChatLine)) return 'Bad chat'
	return {
		reporterId: b.reporterId,
		reportedId: b.reportedId,
		type: b.type,
		message: typeof b.message === 'string' && b.message ? b.message : undefined,
		lobbyId: b.lobbyId,
		lobbyCode: b.lobbyCode,
		runId: typeof b.runId === 'string' ? b.runId : null,
		chat,
	}
}

export interface ReportRelayDeps {
	players: { findPlayerIdsByNakamaUserIds(nakamaUserIds: string[]): Promise<Map<string, string>> }
	reports: { submitNakamaReport(report: NewReport): Promise<number> }
}

export function createReportRelayService(deps: ReportRelayDeps) {
	return {
		async fileReport(report: NakamaReport): Promise<number> {
			const nakamaIds = [report.reporterId, report.reportedId, ...report.chat.map((line) => line.playerId)]
			const playerIds = await deps.players.findPlayerIdsByNakamaUserIds([...new Set(nakamaIds)])
			const playerOf = (nakamaId: string) => playerIds.get(nakamaId) ?? nakamaId
			return deps.reports.submitNakamaReport({
				lobbyId: report.lobbyId,
				lobbyCode: report.lobbyCode.toUpperCase(),
				reporterId: playerOf(report.reporterId),
				reportedId: playerOf(report.reportedId),
				type: report.type,
				runId: report.runId,
				message: report.message,
				chat: report.chat.map((line) => ({
					playerId: playerOf(line.playerId),
					displayName: line.displayName.slice(0, 64),
					message: line.message,
					sentAt: new Date(line.sentAt),
				})),
			})
		},
	}
}

export type ReportRelayService = ReturnType<typeof createReportRelayService>
