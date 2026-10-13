import type {
	IReplayLogRepository,
	RunRow,
	RunWithLogs,
} from '../../contracts/IReplayLogRepository.js'
import * as replayLogGateway from '../../infrastructure/gateways/replay-log.gateway.js'
import { AppError } from '../../shared/utils/errors.js'

// Finished runs and their replay logs, as the Nakama mirror stored them
// (features/nakama/mirror.service.ts), for the website and webadmin.

interface ReplayLogServiceDeps {
	repository: IReplayLogRepository
}

export type ReplayLogService = ReturnType<typeof createReplayLogService>

export function createReplayLogService(deps: ReplayLogServiceDeps) {
	const { repository } = deps

	// GET /api/runs/:runId/replay. Restricted to the run's own participants --
	// there's no broader "public replay" access tier designed yet, so this is
	// the conservative default. isModerator (resolved by the route from the
	// requester's DB-stored privileges, same check webAdmin's middleware uses)
	// bypasses the participant check, so a moderator can open the replay
	// linked from a player report even when they weren't in the match.
	async function getReplay(
		runId: string,
		requesterId: string,
		isModerator = false,
	): Promise<RunWithLogs> {
		const result = await repository.getRunWithLogs(runId)
		if (!result) throw new AppError('Run not found', 404)
		if (
			!isModerator &&
			!result.logs.some((log) => log.playerId === requesterId)
		) {
			throw new AppError('Not a participant in this run', 403)
		}
		return result
	}

	// A player's own past runs, newest first ("My Matches").
	async function listMyRuns(
		playerId: string,
		page = 1,
		pageSize = 20,
	): Promise<{
		runs: RunRow[]
		total: number
		page: number
		pageSize: number
	}> {
		const { runs, total } = await repository.getRunsForPlayer(
			playerId,
			page,
			pageSize,
		)
		return { runs, total, page, pageSize }
	}

	// Admin Match History's "View Log" button: resolves a page of matchIds to
	// their run ids in one query.
	async function getRunIdsForMatchIds(
		matchIds: string[],
	): Promise<Map<string, string>> {
		return repository.getRunIdsForMatchIds(matchIds)
	}

	return { getReplay, listMyRuns, getRunIdsForMatchIds }
}

export const replayLogService = createReplayLogService({
	repository: replayLogGateway,
})
