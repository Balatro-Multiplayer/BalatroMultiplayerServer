import { describe, expect, it, vi } from 'vitest'
import type { IReplayLogRepository } from '../../contracts/IReplayLogRepository.js'
import { createReplayLogService } from '../../features/replay-log/replay-log.service.js'

function makeMockRepository(): IReplayLogRepository {
	return {
		getRunWithLogs: vi.fn().mockResolvedValue(undefined),
		getRunsForPlayer: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
		getRunIdsForMatchIds: vi.fn().mockResolvedValue(new Map()),
	}
}

describe('replay-log.service', () => {
	describe('listMyRuns', () => {
		it('delegates to the repository with the requesting player id and a default limit', async () => {
			const repository = makeMockRepository()
			const runs = [
				{
					id: 'run-1',
					lobbyCode: 'ABCDEF',
					modId: 'mod1',
					lobbyType: 'public',
					status: 'completed' as const,
					startedAt: new Date(),
					finalizedAt: new Date(),
				},
			]
			repository.getRunsForPlayer = vi
				.fn()
				.mockResolvedValue({ runs, total: 1 })
			const service = createReplayLogService({ repository })

			const result = await service.listMyRuns('p1')

			expect(repository.getRunsForPlayer).toHaveBeenCalledWith('p1', 1, 20)
			expect(result).toEqual({ runs, total: 1, page: 1, pageSize: 20 })
		})

		it('returns an empty list when the player has no runs', async () => {
			const repository = makeMockRepository()
			const service = createReplayLogService({ repository })

			const result = await service.listMyRuns('p1')

			expect(result).toEqual({ runs: [], total: 0, page: 1, pageSize: 20 })
		})
	})

	describe('getReplay', () => {
		it('throws 404 when the run does not exist', async () => {
			const repository = makeMockRepository()
			const service = createReplayLogService({ repository })

			await expect(service.getReplay('missing-run', 'p1')).rejects.toThrow(
				'Run not found',
			)
		})

		it('throws 403 when the requester was not a participant', async () => {
			const repository = makeMockRepository()
			vi.mocked(repository.getRunWithLogs).mockResolvedValue({
				run: {
					id: 'run-1',
					lobbyCode: 'ABCDE',
					modId: 'mod1',
					lobbyType: 'public',
					status: 'completed',
					startedAt: new Date(),
					finalizedAt: new Date(),
				},
				logs: [
					{
						playerId: 'p1',
						compressedEvents: 'x',
						carbonHash: null,
						eventCount: 1,
						status: 'complete',
						flagReason: null,
					},
				],
			})
			const service = createReplayLogService({ repository })

			await expect(service.getReplay('run-1', 'someone-else')).rejects.toThrow(
				'Not a participant in this run',
			)
		})

		it('a moderator bypasses the participant check', async () => {
			const repository = makeMockRepository()
			const runWithLogs = {
				run: {
					id: 'run-1',
					lobbyCode: 'ABCDE',
					modId: 'mod1',
					lobbyType: 'public',
					status: 'completed' as const,
					startedAt: new Date(),
					finalizedAt: new Date(),
				},
				logs: [
					{
						playerId: 'p1',
						compressedEvents: 'x',
						carbonHash: null,
						eventCount: 1,
						status: 'complete' as const,
					},
				],
			}
			vi.mocked(repository.getRunWithLogs).mockResolvedValue(runWithLogs)
			const service = createReplayLogService({ repository })

			await expect(
				service.getReplay('run-1', 'someone-else', true),
			).resolves.toEqual(runWithLogs)
		})

		it('returns the run for a participant', async () => {
			const repository = makeMockRepository()
			const runWithLogs = {
				run: {
					id: 'run-1',
					lobbyCode: 'ABCDE',
					modId: 'mod1',
					lobbyType: 'public',
					status: 'completed' as const,
					startedAt: new Date(),
					finalizedAt: new Date(),
				},
				logs: [
					{
						playerId: 'p1',
						compressedEvents: 'x',
						carbonHash: null,
						eventCount: 1,
						status: 'complete' as const,
					},
				],
			}
			vi.mocked(repository.getRunWithLogs).mockResolvedValue(runWithLogs)
			const service = createReplayLogService({ repository })

			await expect(service.getReplay('run-1', 'p1')).resolves.toEqual(
				runWithLogs,
			)
		})
	})
})
