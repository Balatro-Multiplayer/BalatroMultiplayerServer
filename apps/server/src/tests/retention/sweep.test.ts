import { describe, expect, it, vi } from 'vitest'
import type {
	EvidenceCandidate,
	IRetentionRepository,
} from '../../contracts/IRetentionRepository.js'
import { sweepRetention } from '../../features/retention/sweep.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-26T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY)

const old = (id: string): EvidenceCandidate => ({
	id,
	madeAt: daysAgo(200),
	links: [],
})
const openCase = (id: string): EvidenceCandidate => ({
	id,
	madeAt: daysAgo(400),
	links: [{ closedAt: null }],
})
const recentlyClosed = (id: string): EvidenceCandidate => ({
	id,
	madeAt: daysAgo(400),
	links: [{ closedAt: daysAgo(30) }],
})
const longClosed = (id: string): EvidenceCandidate => ({
	id,
	madeAt: daysAgo(400),
	links: [{ closedAt: daysAgo(190) }],
})

function repo(
	overrides: Partial<IRetentionRepository> = {},
): IRetentionRepository {
	return {
		deleteExpiredChat: vi.fn(async () => 7),
		flaggedChatLineCandidates: vi.fn(async () => [
			old('c1'),
			openCase('c2'),
			recentlyClosed('c3'),
			longClosed('c4'),
		]),
		deleteFlaggedChatLines: vi.fn(async (ids: string[]) => ids.length),
		flaggedMessageCandidates: vi.fn(async () => [old('f1'), openCase('f2')]),
		deleteFlaggedMessages: vi.fn(async (ids: string[]) => ids.length),
		runCandidates: vi.fn(async () => [
			old('r1'),
			openCase('r2'),
			longClosed('r3'),
		]),
		deleteRunLogs: vi.fn(async (ids: string[]) => ids.length * 2),
		banRecordCandidates: vi.fn(async () => [
			{ id: 'b-old', expiresAt: new Date('2025-09-01T00:00:00Z') },
			{ id: 'b-recent', expiresAt: new Date('2026-01-01T00:00:00Z') },
		]),
		deleteBanRecords: vi.fn(async (ids: string[]) => ids.length),
		runLinks: vi.fn(async () => new Map()),
		warningCandidates: vi.fn(async () => [old('w1'), openCase('w2')]),
		deleteWarnings: vi.fn(async (ids: string[]) => ids.length),
		integrityEventCandidates: vi.fn(async () => [recentlyClosed('i1'), longClosed('i2')]),
		deleteIntegrityEvents: vi.fn(async (ids: string[]) => ids.length),
		moderationItemCandidates: vi.fn(async () => [old('q1'), openCase('q2'), longClosed('q3')]),
		deleteModerationItems: vi.fn(async (ids: string[]) => ids.length),
		...overrides,
	}
}

const nakamaOk = () =>
	vi.fn(async (runIds: string[]) => ({
		ok: true as const,
		value: { deleted: runIds.length },
	}))

describe('sweepRetention', () => {
	it('deletes only what is past its limit, and keeps evidence an open or recent report or ban uses', async () => {
		const r = repo()
		const purgeNakama = nakamaOk()
		const counts = await sweepRetention(
			{ repo: r, purgeNamedRuns: purgeNakama },
			NOW,
		)

		expect(r.deleteExpiredChat).toHaveBeenCalledWith(NOW)
		expect(r.deleteFlaggedChatLines).toHaveBeenCalledWith(['c1', 'c4'])
		expect(r.deleteFlaggedMessages).toHaveBeenCalledWith(['f1'])
		expect(purgeNakama).toHaveBeenCalledWith(['r1', 'r3'])
		expect(r.deleteRunLogs).toHaveBeenCalledWith(['r1', 'r3'])
		expect(r.deleteBanRecords).toHaveBeenCalledWith(['b-old'])
		expect(r.deleteWarnings).toHaveBeenCalledWith(['w1'])
		expect(r.deleteIntegrityEvents).toHaveBeenCalledWith(['i2'])
		expect(r.deleteModerationItems).toHaveBeenCalledWith(['q1', 'q3'])
		expect(counts).toEqual({
			chat: 7,
			flaggedChat: 2,
			flaggedMessages: 1,
			runs: 2,
			runLogs: 4,
			banRecords: 1,
			warnings: 1,
			integrityEvents: 1,
			moderationItems: 2,
		})
	})

	it('deletes moderation records (reports, queue items) last, after the evidence and warnings that read their links', async () => {
		const order: string[] = []
		const r = repo({
			deleteFlaggedChatLines: vi.fn(async (ids: string[]) => (order.push('chat'), ids.length)),
			deleteWarnings: vi.fn(async (ids: string[]) => (order.push('warnings'), ids.length)),
			deleteIntegrityEvents: vi.fn(async (ids: string[]) => (order.push('integrity'), ids.length)),
			deleteModerationItems: vi.fn(async (ids: string[]) => (order.push('items'), ids.length)),
		})
		await sweepRetention({ repo: r, purgeNamedRuns: nakamaOk() }, NOW)
		expect(order[order.length - 1]).toBe('items')
	})

	it('deletes nothing when nothing is past its limit', async () => {
		const r = repo({
			flaggedChatLineCandidates: vi.fn(async () => [openCase('c2')]),
			flaggedMessageCandidates: vi.fn(async () => []),
			runCandidates: vi.fn(async () => [recentlyClosed('r2')]),
			banRecordCandidates: vi.fn(async () => [
				{ id: 'b', expiresAt: daysAgo(10) },
			]),
		})
		const purgeNakama = nakamaOk()
		await sweepRetention({ repo: r, purgeNamedRuns: purgeNakama }, NOW)
		expect(r.deleteFlaggedChatLines).not.toHaveBeenCalled()
		expect(r.deleteFlaggedMessages).not.toHaveBeenCalled()
		expect(purgeNakama).not.toHaveBeenCalled()
		expect(r.deleteRunLogs).not.toHaveBeenCalled()
		expect(r.deleteBanRecords).not.toHaveBeenCalled()
	})

	it('keeps moderation records while their case is open or a ban from it is in force, then 180 days', async () => {
		const r = repo({
			warningCandidates: vi.fn(async () => [openCase('w'), recentlyClosed('w2')]),
			integrityEventCandidates: vi.fn(async () => [openCase('i')]),
			moderationItemCandidates: vi.fn(async () => [recentlyClosed('q')]),
		})
		await sweepRetention({ repo: r, purgeNamedRuns: nakamaOk() }, NOW)
		expect(r.deleteWarnings).not.toHaveBeenCalled()
		expect(r.deleteIntegrityEvents).not.toHaveBeenCalled()
		expect(r.deleteModerationItems).not.toHaveBeenCalled()
	})

	it("keeps a run's logs when Nakama could not delete the run, so the next sweep tries again", async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const r = repo()
		const failing = vi.fn(async () => ({
			ok: false as const,
			error: 'unreachable' as const,
		}))
		const counts = await sweepRetention(
			{ repo: r, purgeNamedRuns: failing },
			NOW,
		)
		expect(r.deleteRunLogs).not.toHaveBeenCalled()
		expect(counts.runs).toBe(0)
		warn.mockRestore()
	})

	it('deletes run logs when this server has no Nakama admin access', async () => {
		const r = repo()
		const off = vi.fn(async () => ({
			ok: false as const,
			error: 'disabled' as const,
		}))
		await sweepRetention({ repo: r, purgeNamedRuns: off }, NOW)
		expect(r.deleteRunLogs).toHaveBeenCalledWith(['r1', 'r3'])
	})

	it('names runs to Nakama in batches it accepts', async () => {
		const many = Array.from({ length: 250 }, (_, i) => old(`r${i}`))
		const r = repo({ runCandidates: vi.fn(async () => many) })
		const purgeNakama = nakamaOk()
		await sweepRetention({ repo: r, purgeNamedRuns: purgeNakama }, NOW)
		expect(purgeNakama.mock.calls.map(([ids]) => ids.length)).toEqual([
			100, 100, 50,
		])
		expect(r.deleteRunLogs).toHaveBeenCalledTimes(3)
	})
})
