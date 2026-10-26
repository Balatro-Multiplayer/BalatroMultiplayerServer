import { describe, expect, it, vi } from 'vitest'
import { purgeNakamaBanIndex, purgeNakamaIpHashes, purgeNakamaRuns, RUN_RETENTION_DAYS, sweepNakamaCheckpoints } from '../../features/nakama/retention.job.js'

describe('purgeNakamaRuns', () => {
	it('keeps calling while Nakama says there is more, and totals what went', async () => {
		const replies = [
			{ ok: true, value: { deleted: 500, more: true } },
			{ ok: true, value: { deleted: 12, more: false } },
		]
		const rpc = vi.fn(async () => replies.shift())
		expect(await purgeNakamaRuns(rpc as never)).toBe(512)
		expect(rpc).toHaveBeenCalledTimes(2)
		expect(rpc).toHaveBeenCalledWith('admin_runs_purge', { olderThanDays: 180 })
		expect(RUN_RETENTION_DAYS).toBe(180)
	})

	it('stops at a failed call, and quietly when Nakama is off', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const failing = vi.fn(async () => ({ ok: false, error: 'unreachable' }))
		expect(await purgeNakamaRuns(failing as never)).toBe(0)
		expect(warn).toHaveBeenCalledTimes(1)
		const off = vi.fn(async () => ({ ok: false, error: 'disabled' }))
		expect(await purgeNakamaRuns(off as never)).toBe(0)
		expect(warn).toHaveBeenCalledTimes(1)
		warn.mockRestore()
	})

	it('gives up after a bounded number of calls', async () => {
		const rpc = vi.fn(async () => ({ ok: true, value: { deleted: 1, more: true } }))
		expect(await purgeNakamaRuns(rpc as never)).toBe(50)
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
