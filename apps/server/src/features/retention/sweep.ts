import type {
	EvidenceCandidate,
	IRetentionRepository,
} from '../../contracts/IRetentionRepository.js'
import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import type { Result } from '../../shared/utils/result.js'
import { banRecordPurgeable, evidencePurgeable } from './limits.js'

// The hourly retention sweep: deletes chat, evidence and ban records past
// their limit (limits.ts) and nothing else. A run is deleted in Nakama first
// (admin_runs_purge_named), then its logs here, so a failed Nakama call
// leaves the logs for the next sweep to try again.

// Nakama's PURGE_NAMED_MAX (nakama/src/lobby/retention.ts).
export const NAMED_RUNS_PER_CALL = 100

export interface RetentionSweepDeps {
	repo: IRetentionRepository
	purgeNamedRuns(
		runIds: string[],
	): Promise<Result<{ deleted: number }, NakamaRpcError>>
}

export interface RetentionSweepCounts {
	chat: number
	flaggedChat: number
	flaggedMessages: number
	runs: number
	runLogs: number
	banRecords: number
}

export async function sweepRetention(
	deps: RetentionSweepDeps,
	now: Date,
): Promise<RetentionSweepCounts> {
	const { repo } = deps
	const purgeable = async (candidates: Promise<EvidenceCandidate[]>) =>
		(await candidates).filter((c) => evidencePurgeable(c, now)).map((c) => c.id)

	const chat = await repo.deleteExpiredChat(now)

	const lines = await purgeable(repo.flaggedChatLineCandidates(now))
	const flaggedChat =
		lines.length > 0 ? await repo.deleteFlaggedChatLines(lines) : 0

	const messages = await purgeable(repo.flaggedMessageCandidates(now))
	const flaggedMessages =
		messages.length > 0 ? await repo.deleteFlaggedMessages(messages) : 0

	let runs = 0
	let runLogs = 0
	const runIds = await purgeable(repo.runCandidates(now))
	for (let i = 0; i < runIds.length; i += NAMED_RUNS_PER_CALL) {
		const batch = runIds.slice(i, i + NAMED_RUNS_PER_CALL)
		const nakama = await deps.purgeNamedRuns(batch)
		if (!nakama.ok && nakama.error !== 'disabled') {
			console.warn(`[retention] Nakama run purge failed: ${nakama.error}`)
			break
		}
		runLogs += await repo.deleteRunLogs(batch)
		runs += batch.length
	}

	const bans = (await repo.banRecordCandidates(now))
		.filter((b) => banRecordPurgeable(b, now))
		.map((b) => b.id)
	const banRecords = bans.length > 0 ? await repo.deleteBanRecords(bans) : 0

	return { chat, flaggedChat, flaggedMessages, runs, runLogs, banRecords }
}
