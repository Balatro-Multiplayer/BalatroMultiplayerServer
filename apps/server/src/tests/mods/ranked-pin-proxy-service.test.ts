import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type PinProxyDeps,
	pinThroughProxy,
} from '../../features/mods/ranked-pin-proxy.service.js'

const ZIP = Buffer.from('PK\x03\x04 zip bytes')
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex')
const FULL_NAME = 'BalatroMultiplayer-MultiplayerAPI'
const NOW = new Date('2026-12-01T10:00:00Z')
const INSPECTED = {
	hash: 'a'.repeat(64),
	fileHashes: { 'winmm.dll': 'b'.repeat(64) },
	smodsIds: ['MultiplayerAPI'],
}

function makeDeps(overrides: Partial<PinProxyDeps> = {}): PinProxyDeps {
	return {
		findMod: vi.fn().mockResolvedValue({
			id: 'MultiplayerAPI',
			thunderstoreFullName: FULL_NAME,
			rankedVersion: '1.2.2',
		}),
		hasThunderstoreVersion: vi.fn().mockResolvedValue(false),
		setRankedVersion: vi.fn().mockResolvedValue({ ok: true }),
		inspect: vi.fn().mockResolvedValue(INSPECTED),
		storePin: vi.fn().mockResolvedValue(undefined),
		startSwitch: vi.fn().mockResolvedValue(undefined),
		reloadConfig: vi.fn().mockResolvedValue(undefined),
		publicBaseUrl: 'https://balatromp.com',
		skipFirstWait: false,
		now: () => NOW,
		...overrides,
	}
}
const input = { mod: 'MultiplayerAPI', version: '1.2.3', zip: ZIP }
const PROXY_URL =
	'https://balatromp.com/api/mods/MultiplayerAPI/pin-proxy/1.2.3/BalatroMultiplayer-MultiplayerAPI-1.2.3.zip'

let deps: PinProxyDeps
beforeEach(() => {
	deps = makeDeps()
})

describe('pinThroughProxy', () => {
	it('pins the proxy URL with the Thunderstore layout and the asset hash', async () => {
		const result = await pinThroughProxy(input, deps)

		expect(result).toMatchObject({
			ok: true,
			mode: 'proxy',
			proxyUrl: PROXY_URL,
			previousVersion: '1.2.2',
		})
		// Hashed from the posted zip itself, laid out as a Thunderstore package.
		expect(deps.inspect).toHaveBeenCalledWith(
			'MultiplayerAPI',
			'1.2.3',
			ZIP,
			'thunderstore',
		)
		expect(deps.storePin).toHaveBeenCalledWith('MultiplayerAPI', {
			version: '1.2.3',
			downloadUrl: PROXY_URL,
			source: 'thunderstore',
			...INSPECTED,
		})
		expect(deps.reloadConfig).toHaveBeenCalled()
	})

	it('starts the switch 10 minutes out and keeps the proxy hash', async () => {
		await pinThroughProxy(input, deps)

		expect(deps.startSwitch).toHaveBeenCalledWith({
			modId: 'MultiplayerAPI',
			version: '1.2.3',
			assetName: 'BalatroMultiplayer-MultiplayerAPI-1.2.3.zip',
			proxyUrl: PROXY_URL,
			proxyHash: INSPECTED.hash,
			zipBytes: ZIP,
			zipSha256: ZIP_SHA,
			startedAt: NOW,
			nextCheckAt: new Date('2026-12-01T10:10:00Z'),
		})
	})

	it('writes the switch before the pin, so the proxy URL always has a row', async () => {
		const order: string[] = []
		deps = makeDeps({
			startSwitch: vi.fn(async () => void order.push('switch')),
			storePin: vi.fn(async () => void order.push('pin')),
		})
		await pinThroughProxy(input, deps)
		expect(order).toEqual(['switch', 'pin'])
	})

	it('allows only MultiplayerAPI', async () => {
		deps = makeDeps({
			findMod: vi.fn().mockResolvedValue({
				id: 'MultiplayerPvP',
				thunderstoreFullName: FULL_NAME,
				rankedVersion: null,
			}),
		})
		expect(await pinThroughProxy(input, deps)).toEqual({
			ok: false,
			reason: 'mod-not-allowed',
		})
		expect(deps.inspect).not.toHaveBeenCalled()
		expect(deps.storePin).not.toHaveBeenCalled()
	})

	it('refuses an unknown mod and a bad version', async () => {
		deps = makeDeps({ findMod: vi.fn().mockResolvedValue(null) })
		expect(await pinThroughProxy(input, deps)).toEqual({
			ok: false,
			reason: 'mod-not-found',
		})
		deps = makeDeps()
		expect(await pinThroughProxy({ ...input, version: 'v1' }, deps)).toEqual({
			ok: false,
			reason: 'bad-version',
		})
		expect(deps.inspect).not.toHaveBeenCalled()
	})

	it('changes nothing when the zip cannot be hashed', async () => {
		deps = makeDeps({ inspect: vi.fn().mockResolvedValue(null) })
		expect(await pinThroughProxy(input, deps)).toEqual({
			ok: false,
			reason: 'hash-failed',
		})
		expect(deps.startSwitch).not.toHaveBeenCalled()
		expect(deps.storePin).not.toHaveBeenCalled()
	})

	it('pins the normal way when Thunderstore already lists the version', async () => {
		deps = makeDeps({ hasThunderstoreVersion: vi.fn().mockResolvedValue(true) })
		const result = await pinThroughProxy(input, deps)

		expect(result).toMatchObject({ ok: true, mode: 'thunderstore' })
		expect(deps.setRankedVersion).toHaveBeenCalledWith(
			'MultiplayerAPI',
			'1.2.3',
		)
		expect(deps.storePin).not.toHaveBeenCalled()
		expect(deps.startSwitch).not.toHaveBeenCalled()
	})

	it('serves through the proxy when forced, even if Thunderstore lists the version', async () => {
		deps = makeDeps({ hasThunderstoreVersion: vi.fn().mockResolvedValue(true) })
		const result = await pinThroughProxy({ ...input, forceProxy: true }, deps)

		expect(result).toMatchObject({
			ok: true,
			mode: 'proxy',
			proxyUrl: PROXY_URL,
		})
		expect(deps.setRankedVersion).not.toHaveBeenCalled()
		expect(deps.startSwitch).toHaveBeenCalled()
		expect(deps.storePin).toHaveBeenCalled()
	})

	it('checks Thunderstore at once when the first wait is skipped', async () => {
		deps = makeDeps({ skipFirstWait: true })
		const result = await pinThroughProxy(input, deps)

		expect(result).toMatchObject({ ok: true, mode: 'proxy', nextCheckAt: NOW })
		expect(deps.startSwitch).toHaveBeenCalledWith(
			expect.objectContaining({ nextCheckAt: NOW }),
		)
	})
})
