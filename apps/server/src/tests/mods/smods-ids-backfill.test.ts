import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../infrastructure/gateways/mods.gateway.js', () => ({
	listRankedPins: vi.fn(),
	storePinSmodsIds: vi.fn(),
}))
vi.mock('../../infrastructure/gateways/config.gateway.js', () => ({
	loadConfigFromDb: vi.fn(),
}))
vi.mock('../../features/mods/mod-version-hash.js', () => ({
	inspectModRelease: vi.fn(),
}))

import { inspectModRelease } from '../../features/mods/mod-version-hash.js'
import { fillMissingSmodsIds } from '../../features/mods/smods-ids-backfill.service.js'
import { loadConfigFromDb } from '../../infrastructure/gateways/config.gateway.js'
import * as gateway from '../../infrastructure/gateways/mods.gateway.js'

type Pin = Awaited<ReturnType<typeof gateway.listRankedPins>>[number]

// A pin made before migration 0051: pinned, downloadable, ids never read.
function pin(overrides: Partial<Pin> = {}): Pin {
	return {
		id: 'Alice-Mod',
		thunderstoreFullName: 'Alice-Mod',
		repoUrl: null,
		rankedVersion: '2.0.0',
		rankedVersionSha256: 'b'.repeat(64),
		rankedDownloadUrl: 'https://ts/Alice-Mod/2.0.0/',
		rankedSource: 'thunderstore',
		rankedDownloadStatus: 'ok',
		smodsIds: [],
		smodsIdsReadVersion: null,
		...overrides,
	}
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.mocked(gateway.listRankedPins).mockResolvedValue([])
	vi.mocked(inspectModRelease).mockResolvedValue({
		hash: 'h',
		smodsIds: ['AliceMod'],
	})
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fillMissingSmodsIds (API boot)', () => {
	it('reads the ids of a pin that has none and pushes the new allowed-mod set', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([pin()])

		await fillMissingSmodsIds()

		expect(gateway.storePinSmodsIds).toHaveBeenCalledWith(
			'Alice-Mod',
			'2.0.0',
			['AliceMod'],
		)
		expect(loadConfigFromDb).toHaveBeenCalledTimes(1)
	})

	it('reads a pin again after its version changes', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			pin({ rankedVersion: '3.0.0', smodsIdsReadVersion: '2.0.0' }),
		])

		await fillMissingSmodsIds()

		expect(gateway.storePinSmodsIds).toHaveBeenCalledWith(
			'Alice-Mod',
			'3.0.0',
			['AliceMod'],
		)
	})

	it('leaves alone a pin whose files declare no SMODS id once it has been read', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			pin({
				id: 'Steamodded-Steamodded',
				smodsIds: [],
				smodsIdsReadVersion: '2.0.0',
			}),
		])

		await fillMissingSmodsIds()

		expect(inspectModRelease).not.toHaveBeenCalled()
		expect(loadConfigFromDb).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it('records a read that finds no id, so the next boot skips it', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			pin({ id: 'Thunderstore-lovely' }),
		])
		vi.mocked(inspectModRelease).mockResolvedValue({ hash: 'h', smodsIds: [] })

		await fillMissingSmodsIds()

		expect(gateway.storePinSmodsIds).toHaveBeenCalledWith(
			'Thunderstore-lovely',
			'2.0.0',
			[],
		)
		expect(warn).not.toHaveBeenCalled()
	})

	it('skips a pin with ids an admin set, or with no download to read', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			pin({ id: 'Set-ByAdmin', smodsIds: ['Custom'] }),
			pin({ id: 'No-Download', rankedDownloadUrl: null }),
		])

		await fillMissingSmodsIds()

		expect(inspectModRelease).not.toHaveBeenCalled()
		expect(loadConfigFromDb).not.toHaveBeenCalled()
	})

	it('warns about a pin whose ids cannot be read and still fills the others', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			pin({ id: 'Dead-Link' }),
			pin({ id: 'Bob-Mod' }),
		])
		vi.mocked(inspectModRelease).mockImplementation(async (modId) =>
			modId === 'Dead-Link' ? null : { hash: 'h', smodsIds: ['BobMod'] },
		)

		await fillMissingSmodsIds()

		expect(gateway.storePinSmodsIds).toHaveBeenCalledTimes(1)
		expect(gateway.storePinSmodsIds).toHaveBeenCalledWith('Bob-Mod', '2.0.0', [
			'BobMod',
		])
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Dead-Link@2.0.0'),
		)
		expect(loadConfigFromDb).toHaveBeenCalledTimes(1)
	})

	it('never throws, so the boot does not fail', async () => {
		vi.mocked(gateway.listRankedPins).mockRejectedValue(new Error('db down'))

		await expect(fillMissingSmodsIds()).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalled()
	})
})
