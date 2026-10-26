import type { EvidenceLink } from '../features/retention/limits.js'

// A piece of evidence whose stored limit has passed: the sweep deletes it
// unless a report or ban that uses it says to keep it longer.
export interface EvidenceCandidate {
	id: string
	madeAt: Date
	links: EvidenceLink[]
}

export interface BanRecordCandidate {
	id: string
	expiresAt: Date | null
}

export interface IRetentionRepository {
	// Normal (not flagged) chat lines past their 90 days. Returns how many went.
	deleteExpiredChat(now: Date): Promise<number>
	// Flagged chat_logs lines, by id.
	flaggedChatLineCandidates(now: Date): Promise<EvidenceCandidate[]>
	deleteFlaggedChatLines(ids: string[]): Promise<number>
	// flagged_messages rows, by id.
	flaggedMessageCandidates(now: Date): Promise<EvidenceCandidate[]>
	deleteFlaggedMessages(ids: string[]): Promise<number>
	// Runs whose logs passed their limit, by run id.
	runCandidates(now: Date): Promise<EvidenceCandidate[]>
	// Deletes every log of the runs. Returns how many logs went.
	deleteRunLogs(runIds: string[]): Promise<number>
	// Ban records that ran out.
	banRecordCandidates(now: Date): Promise<BanRecordCandidate[]>
	deleteBanRecords(ids: string[]): Promise<number>
}
