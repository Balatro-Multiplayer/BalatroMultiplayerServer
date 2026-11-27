import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type PinProxySwitchDeps,
	runPinProxySwitches,
} from '../../features/mods/pin-proxy-switch.service.js'
import {
	PIN_PROXY_FIRST_CHECK_MS,
	PIN_PROXY_GIVE_UP_MS,
	PIN_PROXY_RETRY_MS,
} from '../../features/mods/pin-proxy.js'
import type { PinProxySwitchRow } from '../../infrastructure/gateways/mod-pin-proxy.gateway.js'

const START = new Date('2026-12-01T10:00:00Z')
const PROXY_URL =
	'https://balatromp.com/api/mods/MultiplayerAPI/pin-proxy/1.2.3/MultiplayerAPI-1.2.3.zip'
const TS_URL =
	'https://thunderstore.io/package/download/BalatroMultiplayer/MultiplayerAPI/1.2.3/'
const HASH = 'a'.repeat(64)
const minutes = (n: number) => n * 60 * 1000

// A small in-memory stand-in for the switch table that claims the way the
// gateway does: a pending row that is due moves its next check by the lease.
function harness(opts?: { thunderstore?: 'up' | 'not-up' }) {
	const state = {
		now: new Date(START),
		row: {
			id: 1,
			modId: 'MultiplayerAPI',
			version: '1.2.3',
			assetName: 'x.zip',
			proxyUrl: PROXY_URL,
			proxyHash: HASH,
			state: 'pending',
			startedAt: START,
			nextCheckAt: new Date(START.getTime() + PIN_PROXY_FIRST_CHECK_MS),
			lastCheckedAt: null,
			attempts: 0,
			finishedAt: null,
			note: null,
		} as PinProxySwitchRow,
		mod: {
			id: 'MultiplayerAPI',
			thunderstoreFullName: 'BalatroMultiplayer-MultiplayerAPI',
			rankedVersion: '1.2.3' as string | null,
			rankedDownloadUrl: PROXY_URL as string | null,
		},
		thunderstore: opts?.thunderstore ?? 'not-up',
		// What the move reports; the real one hashes the Thunderstore download.
		moveHash: HASH,
		zipCleared: false,
	}
	const deps: PinProxySwitchDeps = {
		claimDue: vi.fn(async (now: Date, leaseMs: number) => {
			const r = state.row
			if (r.state !== 'pending' || r.nextCheckAt > now) return []
			state.row = {
				...r,
				nextCheckAt: new Date(now.getTime() + leaseMs),
				lastCheckedAt: now,
				attempts: r.attempts + 1,
			}
			return [state.row]
		}),
		findMod: vi.fn(async () => ({ ...state.mod })),
		thunderstoreStatus: vi.fn(async () => state.thunderstore),
		refreshVersions: vi.fn(async () => undefined),
		moveToThunderstore: vi.fn(async (_id, _version, proxyUrl) => {
			// The real write is conditional on the pin still being the proxy pin.
			if (state.mod.rankedDownloadUrl !== proxyUrl)
				return { ok: false as const, reason: 'pin-changed' as const }
			state.mod.rankedDownloadUrl = TS_URL
			return { ok: true as const, hash: state.moveHash, previousHash: HASH }
		}),
		note: vi.fn(async (_id, note) => {
			state.row = { ...state.row, note }
		}),
		clearZip: vi.fn(async () => {
			state.zipCleared = true
		}),
		finish: vi.fn(async (_id, finalState, note, now) => {
			state.row = { ...state.row, state: finalState, note, finishedAt: now }
		}),
		reloadConfig: vi.fn(async () => undefined),
		logSwitch: vi.fn(async () => undefined),
		now: () => state.now,
	}
	const at = (ms: number) => {
		state.now = new Date(START.getTime() + ms)
	}
	const tick = () => runPinProxySwitches(deps)
	return { state, deps, at, tick }
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('pin proxy timer', () => {
	it('does nothing before the first check at 10 minutes', async () => {
		const h = harness({ thunderstore: 'up' })
		h.at(PIN_PROXY_FIRST_CHECK_MS - 1)
		expect(await h.tick()).toEqual([])
		expect(h.deps.thunderstoreStatus).not.toHaveBeenCalled()
	})

	it('checks at 10 minutes, then every 2 minutes, until Thunderstore has it', async () => {
		const h = harness()
		h.at(minutes(10))
		expect(await h.tick()).toEqual(['waiting'])
		expect(h.state.row.nextCheckAt).toEqual(
			new Date(START.getTime() + minutes(12)),
		)

		h.at(minutes(11) + 59_000)
		expect(await h.tick()).toEqual([])
		h.at(minutes(12))
		expect(await h.tick()).toEqual(['waiting'])
		h.at(minutes(14))
		expect(await h.tick()).toEqual(['waiting'])

		expect(h.deps.thunderstoreStatus).toHaveBeenCalledTimes(3)
		expect(h.state.row.attempts).toBe(3)
		expect(h.state.row.state).toBe('pending')
		expect(h.deps.moveToThunderstore).not.toHaveBeenCalled()
		expect(h.state.mod.rankedDownloadUrl).toBe(PROXY_URL)
	})

	it('refreshes the Thunderstore versions, then moves the pin when the version is up', async () => {
		const h = harness()
		h.at(minutes(10))
		await h.tick()
		h.state.thunderstore = 'up'
		h.at(minutes(12))

		expect(await h.tick()).toEqual(['switched'])

		const order = [
			vi.mocked(h.deps.refreshVersions).mock.invocationCallOrder[0] ?? 0,
			vi.mocked(h.deps.moveToThunderstore).mock.invocationCallOrder[0] ?? 0,
		]
		expect(order[0]).toBeLessThan(order[1] as number)
		expect(h.deps.moveToThunderstore).toHaveBeenCalledWith(
			'MultiplayerAPI',
			'1.2.3',
			PROXY_URL,
		)
		expect(h.state.row.state).toBe('switched')
		// The pin no longer uses the proxy URL, so the stored zip goes.
		expect(h.state.zipCleared).toBe(true)
		expect(h.state.mod.rankedDownloadUrl).toBe(TS_URL)
		expect(h.deps.reloadConfig).toHaveBeenCalled()
		expect(h.deps.logSwitch).toHaveBeenCalledWith(
			expect.objectContaining({ hashChanged: false, proxyHash: HASH }),
		)

		// A finished switch is never taken again.
		h.at(minutes(20))
		expect(await h.tick()).toEqual([])
	})

	it('logs a warning and records it when the Thunderstore hash differs', async () => {
		const h = harness({ thunderstore: 'up' })
		h.state.moveHash = 'c'.repeat(64)
		h.at(minutes(10))

		expect(await h.tick()).toEqual(['switched'])

		expect(h.deps.logSwitch).toHaveBeenCalledWith(
			expect.objectContaining({ hashChanged: true, hash: 'c'.repeat(64) }),
		)
		expect(h.state.row.note).toContain('different')
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('differs from the proxy hash'),
		)
	})

	it('does not switch after an admin re-pinned another version', async () => {
		const h = harness({ thunderstore: 'up' })
		h.state.mod.rankedVersion = '1.2.4'
		h.state.mod.rankedDownloadUrl = TS_URL.replace('1.2.3', '1.2.4')
		h.at(minutes(10))

		expect(await h.tick()).toEqual(['superseded'])

		expect(h.deps.thunderstoreStatus).not.toHaveBeenCalled()
		expect(h.deps.moveToThunderstore).not.toHaveBeenCalled()
		expect(h.state.row.state).toBe('superseded')
		expect(h.state.zipCleared).toBe(true)
		expect(h.state.mod.rankedDownloadUrl).toBe(TS_URL.replace('1.2.3', '1.2.4'))
	})

	it('does not switch after an admin re-pinned the same version to Thunderstore', async () => {
		const h = harness({ thunderstore: 'up' })
		h.state.mod.rankedDownloadUrl = TS_URL
		h.at(minutes(10))

		expect(await h.tick()).toEqual(['superseded'])
		expect(h.deps.moveToThunderstore).not.toHaveBeenCalled()
	})

	it('does not switch after an admin un-ranked the mod', async () => {
		const h = harness({ thunderstore: 'up' })
		h.state.mod.rankedVersion = null
		h.state.mod.rankedDownloadUrl = null
		h.at(minutes(10))
		expect(await h.tick()).toEqual(['superseded'])
	})

	it('leaves an admin pin alone when it lands between the check and the write', async () => {
		const h = harness({ thunderstore: 'up' })
		vi.mocked(h.deps.refreshVersions).mockImplementation(async () => {
			h.state.mod.rankedDownloadUrl = 'https://example.com/admin-pin.zip'
		})
		h.at(minutes(10))

		expect(await h.tick()).toEqual(['superseded'])
		expect(h.state.mod.rankedDownloadUrl).toBe(
			'https://example.com/admin-pin.zip',
		)
	})

	it('keeps asking when Thunderstore is up but the Server list lacks the version', async () => {
		const h = harness({ thunderstore: 'up' })
		vi.mocked(h.deps.moveToThunderstore).mockResolvedValueOnce({
			ok: false,
			reason: 'not-listed',
		})
		h.at(minutes(10))
		expect(await h.tick()).toEqual(['waiting'])
		expect(h.state.row.state).toBe('pending')

		h.at(minutes(12))
		expect(await h.tick()).toEqual(['switched'])
	})

	it('keeps asking after an error', async () => {
		const h = harness({ thunderstore: 'up' })
		vi.mocked(h.deps.thunderstoreStatus).mockRejectedValueOnce(
			new Error('boom'),
		)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		h.at(minutes(10))
		expect(await h.tick()).toEqual(['waiting'])
		h.at(minutes(12))
		expect(await h.tick()).toEqual(['switched'])
	})

	it('gives up after 7 days and leaves the proxy pin in place', async () => {
		const h = harness()
		// A tick that has been checking all along; the check at day 7 gives up.
		h.state.row = {
			...h.state.row,
			nextCheckAt: new Date(START.getTime() + PIN_PROXY_GIVE_UP_MS - 1000),
		}
		h.at(PIN_PROXY_GIVE_UP_MS - 1000)
		expect(await h.tick()).toEqual(['waiting'])

		h.at(PIN_PROXY_GIVE_UP_MS - 1000 + PIN_PROXY_RETRY_MS)
		expect(await h.tick()).toEqual(['gave_up'])

		expect(h.state.row.state).toBe('gave_up')
		// The pin still points at the proxy, so the zip stays.
		expect(h.state.zipCleared).toBe(false)
		expect(h.state.mod.rankedDownloadUrl).toBe(PROXY_URL)
		expect(h.deps.moveToThunderstore).not.toHaveBeenCalled()
		h.at(PIN_PROXY_GIVE_UP_MS + minutes(60))
		expect(await h.tick()).toEqual([])
	})

	it('picks up a switch that came due while the Server was down', async () => {
		const h = harness({ thunderstore: 'up' })
		// A restart: nothing in memory, only the stored row.
		h.at(minutes(45))
		expect(await h.tick()).toEqual(['switched'])
	})
})
