import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../infrastructure/gateways/mods.gateway.js', () => ({
	listRankedPins: vi.fn(),
	storePinFileHashes: vi.fn(),
}))

vi.mock('../../features/mods/mod-version-hash.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../features/mods/mod-version-hash.js')>()),
	inspectModRelease: vi.fn(),
}))

import {
	hashInjectorFiles,
	inspectModRelease,
} from '../../features/mods/mod-version-hash.js'
import { backfillRankedFileHashes } from '../../features/mods/ranked-file-hashes-backfill.service.js'
import * as gateway from '../../infrastructure/gateways/mods.gateway.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('hashInjectorFiles', () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmp-injector-test-'))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it('hashes injector files wherever they sit, by lower-case name', async () => {
		await fs.mkdir(path.join(dir, 'lovely-x86_64'), { recursive: true })
		await fs.writeFile(path.join(dir, 'lovely-x86_64', 'WINMM.dll'), 'dll-a')
		await fs.writeFile(path.join(dir, 'readme.md'), 'ignored')
		expect(await hashInjectorFiles(dir)).toEqual({ 'winmm.dll': sha('dll-a') })
	})

	it('prefers the shallowest copy', async () => {
		await fs.mkdir(path.join(dir, 'deep', 'er'), { recursive: true })
		await fs.writeFile(path.join(dir, 'deep', 'er', 'winmm.dll'), 'deep')
		await fs.writeFile(path.join(dir, 'winmm.dll'), 'top')
		expect(await hashInjectorFiles(dir)).toEqual({ 'winmm.dll': sha('top') })
	})

	it('picks the same copy at equal depth whatever the directory order', async () => {
		await fs.mkdir(path.join(dir, 'b'))
		await fs.mkdir(path.join(dir, 'a'))
		await fs.writeFile(path.join(dir, 'b', 'winmm.dll'), 'from-b')
		await fs.writeFile(path.join(dir, 'a', 'winmm.dll'), 'from-a')
		expect(await hashInjectorFiles(dir)).toEqual({ 'winmm.dll': sha('from-a') })
	})

	it('returns {} when the pin ships no injector file', async () => {
		await fs.writeFile(path.join(dir, 'main.lua'), 'x')
		expect(await hashInjectorFiles(dir)).toEqual({})
	})
})

describe('backfillRankedFileHashes', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
	})
	afterEach(() => vi.restoreAllMocks())

	it('skips non-Lovely pins and pins already read', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([
			{ id: 'Alice-Mod', rankedFileHashes: null },
			{ id: 'Thunderstore-lovely', rankedFileHashes: {} },
		] as never)
		const summary = await backfillRankedFileHashes()
		expect(summary).toEqual({ read: 0, failed: 0, skipped: 2 })
		expect(gateway.storePinFileHashes).not.toHaveBeenCalled()
	})

	const lovelyPin = {
		id: 'Thunderstore-lovely',
		rankedVersion: '1.0.0',
		rankedVersionSha256: 'pinned-hash',
		rankedFileHashes: null,
		rankedDownloadUrl: 'https://example.com/lovely.zip',
		rankedSource: 'thunderstore',
	}

	it('stores the hashes when the download matches the pinned hash', async () => {
		vi.mocked(gateway.listRankedPins).mockResolvedValue([lovelyPin] as never)
		vi.mocked(inspectModRelease).mockResolvedValue({
			hash: 'pinned-hash',
			fileHashes: { 'winmm.dll': 'abc' },
			smodsIds: [],
		})
		const summary = await backfillRankedFileHashes()
		expect(summary).toEqual({ read: 1, failed: 0, skipped: 0 })
		expect(gateway.storePinFileHashes).toHaveBeenCalledWith(
			'Thunderstore-lovely',
			'1.0.0',
			{ 'winmm.dll': 'abc' },
		)
	})

	it('skips a pin whose download no longer matches the pinned hash', async () => {
		vi.mocked(gateway.storePinFileHashes).mockClear()
		vi.mocked(gateway.listRankedPins).mockResolvedValue([lovelyPin] as never)
		vi.mocked(inspectModRelease).mockResolvedValue({
			hash: 'other-hash',
			fileHashes: { 'winmm.dll': 'abc' },
			smodsIds: [],
		})
		const summary = await backfillRankedFileHashes()
		expect(summary).toEqual({ read: 0, failed: 1, skipped: 0 })
		expect(gateway.storePinFileHashes).not.toHaveBeenCalled()
		expect(console.warn).toHaveBeenCalled()
	})
})
