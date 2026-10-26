import type { EvidenceUse } from '../../contracts/IRetentionRepository.js'
import { describe, expect, it, vi } from 'vitest'
import { purgeNakamaBanIndex, purgeNakamaIpHashes, purgeNakamaRuns, RUN_RETENTION_DAYS, sweepNakamaCheckpoints } from '../../features/nakama/retention.job.js'

describe('purgeNakamaRuns', () => {
	const DAY = 24 * 60 * 60 * 1000
	const now = new Date(1000 * DAY)
	const old = now.getTime() - 200 * DAY
	const ok = <T>(value: T) => ({ ok: true, value })

	// Nakama's answers per RPC; admin_runs_expired pages in order.
	function fakeRpc(pages: { runs: { runId: string; endedAt: number }[]; cursor: string }[]) {
		const named: string[][] = []
		const rpc = vi.fn(async (id: string, body: Record<string, unknown>) => {
			if (id === 'admin_runs_expired') return ok(pages.shift())
			if (id === 'admin_runs_purge_named') {
				named.push(body.runIds as string[])
				return ok({ deleted: (body.runIds as string[]).length })
			}
			throw new Error(id)
		})
		return { rpc, named }
	}

	it('deletes the old runs no report or ban uses, and keeps the ones still used', async () => {
		const { rpc, named } = fakeRpc([
			{ runs: [{ runId: 'free', endedAt: old }, { runId: 'reported', endedAt: old }], cursor: 'c1' },
			{ runs: [{ runId: 'banned', endedAt: old }, { runId: 'closed-long-ago', endedAt: old }], cursor: '' },
		])
		const runLinks = vi.fn(async (runIds: string[]) => {
			const links = new Map<string, EvidenceUse[]>()
			for (const id of runIds) {
				if (id === 'reported') links.set(id, [{ kind: 'item', status: 'open', resolvedAt: null }])
				if (id === 'banned')
					links.set(id, [{ kind: 'ban', expiresAt: null, liftedAt: new Date(now.getTime() - 10 * DAY) }])
				if (id === 'closed-long-ago')
					links.set(id, [{ kind: 'item', status: 'resolved', resolvedAt: new Date(now.getTime() - 190 * DAY) }])
			}
			return links
		})

		expect(await purgeNakamaRuns({ rpc: rpc as never, runLinks }, now)).toBe(2)
		expect(named.flat()).toEqual(['free', 'closed-long-ago'])
		expect(rpc).toHaveBeenCalledWith('admin_runs_expired', { olderThanDays: 180, cursor: '' })
		expect(rpc).toHaveBeenCalledWith('admin_runs_expired', { olderThanDays: 180, cursor: 'c1' })
		expect(RUN_RETENTION_DAYS).toBe(180)
	})

	it('stops at a failed call, and quietly when Nakama is off', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const runLinks = vi.fn(async () => new Map())
		const failing = vi.fn(async () => ({ ok: false, error: 'unreachable' }))
		expect(await purgeNakamaRuns({ rpc: failing as never, runLinks }, now)).toBe(0)
		expect(warn).toHaveBeenCalledTimes(1)
		const off = vi.fn(async () => ({ ok: false, error: 'disabled' }))
		expect(await purgeNakamaRuns({ rpc: off as never, runLinks }, now)).toBe(0)
		expect(warn).toHaveBeenCalledTimes(1)
		warn.mockRestore()
	})

	it('gives up after a bounded number of pages', async () => {
		const rpc = vi.fn(async (id: string) =>
			id === 'admin_runs_expired' ? ok({ runs: [{ runId: 'r', endedAt: old }], cursor: 'more' }) : ok({ deleted: 1 }),
		)
		expect(await purgeNakamaRuns({ rpc: rpc as never, runLinks: async () => new Map() }, now)).toBe(50)
	})
})

describe('sweepNakamaCheckpoints', () => {
	it('keeps calling while Nakama says there is more, and totals the counts', async () => {
		const replies = [
			{ ok: true, value: { deleted: 200, noContest: 3, more: true } },
			{ ok: true, value: { deleted: 5, noContest: 1, more: false } },
		]
		const rpc = vi.fn(async () => replies.shift())
		expect(await sweepNakamaCheckpoints(rpc as never)).toEqual({ deleted: 205, noContest: 4 })
		expect(rpc).toHaveBeenCalledWith('admin_checkpoints_sweep', {})
	})

	it('stops at a failed call', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const rpc = vi.fn(async () => ({ ok: false, error: 'unreachable' }))
		expect(await sweepNakamaCheckpoints(rpc as never)).toEqual({ deleted: 0, noContest: 0 })
		expect(warn).toHaveBeenCalledTimes(1)
		warn.mockRestore()
	})
})

describe('purgeNakamaIpHashes', () => {
	it('keeps calling while Nakama says there is more, and totals what went', async () => {
		const replies = [
			{ ok: true, value: { deleted: 40, more: true } },
			{ ok: true, value: { deleted: 2, more: false } },
		]
		const rpc = vi.fn(async () => replies.shift())
		expect(await purgeNakamaIpHashes(rpc as never)).toBe(42)
		expect(rpc).toHaveBeenCalledWith('admin_ip_hashes_purge', {})
	})

	it('stops quietly when Nakama is off', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const rpc = vi.fn(async () => ({ ok: false, error: 'disabled' }))
		expect(await purgeNakamaIpHashes(rpc as never)).toBe(0)
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe('purgeNakamaBanIndex', () => {
	it('keeps calling while Nakama says there is more, and totals what went', async () => {
		const replies = [
			{ ok: true, value: { deleted: 3, more: true } },
			{ ok: true, value: { deleted: 1, more: false } },
		]
		const rpc = vi.fn(async () => replies.shift())
		expect(await purgeNakamaBanIndex(rpc as never)).toBe(4)
		expect(rpc).toHaveBeenCalledWith('admin_ban_index_purge', {})
	})
})
