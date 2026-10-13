import { describe, expect, it, vi } from 'vitest'
import { purgeNakamaRuns, RUN_RETENTION_DAYS } from '../../features/nakama/retention.job.js'

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
