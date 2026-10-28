import type { EvidenceUse } from '../../contracts/IRetentionRepository.js'
import { describe, expect, it, vi } from 'vitest'
import { purgeDeletedPlayerHashes, purgeNakamaIpHashes, purgeNakamaRuns, sweepNakamaCheckpoints } from '../../features/nakama/retention.job.js'

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

describe('purgeDeletedPlayerHashes', () => {
	const expired = [
		{ id: 'anon-1', steamIdHash: 'h1' },
		{ id: 'anon-2', steamIdHash: 'h2' },
	]

	it('has Nakama forget the ban index entries first, then clears the hashes in Postgres', async () => {
		const calls: string[] = []
		const rpc = vi.fn(async (id: string) => {
			calls.push(id)
			return { ok: true, value: { deleted: 2 } }
		})
		const clear = vi.fn(async (ids: string[]) => {
			calls.push('clear')
			return ids.length
		})
		expect(await purgeDeletedPlayerHashes({ rpc: rpc as never, expired: async () => expired, clear })).toBe(2)
		expect(rpc).toHaveBeenCalledWith('admin_ban_index_forget', { steamIdHashes: ['h1', 'h2'] })
		expect(clear).toHaveBeenCalledWith(['anon-1', 'anon-2'])
		expect(calls).toEqual(['admin_ban_index_forget', 'clear'])
	})

	it('keeps the hashes in Postgres while Nakama cannot forget them, so the next hour retries', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const clear = vi.fn(async () => 0)
		const rpc = vi.fn(async () => ({ ok: false, error: 'unavailable' }))
		expect(await purgeDeletedPlayerHashes({ rpc: rpc as never, expired: async () => expired, clear })).toBe(0)
		expect(clear).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it('clears them when no Nakama is set up, and calls nothing when none expired', async () => {
		const clear = vi.fn(async (ids: string[]) => ids.length)
		const disabled = vi.fn(async () => ({ ok: false, error: 'disabled' }))
		expect(await purgeDeletedPlayerHashes({ rpc: disabled as never, expired: async () => expired, clear })).toBe(2)
		const rpc = vi.fn()
		expect(await purgeDeletedPlayerHashes({ rpc: rpc as never, expired: async () => [], clear })).toBe(0)
		expect(rpc).not.toHaveBeenCalled()
	})
})
