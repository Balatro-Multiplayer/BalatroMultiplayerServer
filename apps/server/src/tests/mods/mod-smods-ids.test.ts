import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSmodsIdsOverride, readSmodsIds, smodsIdsOfFiles } from '../../features/mods/mod-smods-ids.js'

// Shaped after the real manifests of the stock dev mods.
const MPAPI_MANIFEST = JSON.stringify({
	id: 'MultiplayerAPI',
	name: 'MultiplayerAPI',
	author: ['Virtualized'],
	prefix: 'mpapi',
	main_file: 'core.lua',
	version: '1.0.0',
})
const HEADER_MOD = ['--- STEAMODDED HEADER', '--- MOD_NAME: Old Style', '--- MOD_ID: OldStyle', '--- MOD_AUTHOR: [x]', '', 'print(1)'].join('\n')

describe('SMODS ids a mod declares', () => {
	it('reads a JSON manifest id', () => {
		expect(smodsIdsOfFiles([{ path: 'MultiplayerAPI.json', content: MPAPI_MANIFEST }])).toEqual(['MultiplayerAPI'])
	})
	it("ignores JSON that isn't a manifest", () => {
		expect(
			smodsIdsOfFiles([
				{ path: 'localization/en-us.json', content: '{"id":"nope"}' },
				{ path: 'config.json', content: '[1,2]' },
				{ path: 'broken.json', content: '{' },
				{ path: 'Steamodded/manifest.json', content: '{"version":"1.0.0"}' },
			]),
		).toEqual([])
	})
	it('reads a Lua header, only from a file that starts with one', () => {
		expect(smodsIdsOfFiles([{ path: 'old.lua', content: HEADER_MOD }])).toEqual(['OldStyle'])
		expect(smodsIdsOfFiles([{ path: 'old.lua', content: '﻿' + HEADER_MOD.replace(/\n/g, '\r\n') }])).toEqual([
			'OldStyle',
		])
		expect(smodsIdsOfFiles([{ path: 'lib.lua', content: 'local x = 1\n--- MOD_ID: Fake' }])).toEqual([])
		expect(
			smodsIdsOfFiles([{ path: 'late.lua', content: '--- STEAMODDED HEADER\n--- MOD_NAME: x\nlocal y\n--- MOD_ID: Late' }]),
		).toEqual([])
	})
	it('collects every mod in a multi-mod archive, once each, sorted', () => {
		expect(
			smodsIdsOfFiles([
				{ path: 'b/B.json', content: JSON.stringify({ id: 'Bravo', main_file: 'b.lua' }) },
				{ path: 'a/A.json', content: JSON.stringify({ id: 'Alpha', main_file: 'a.lua' }) },
				{ path: 'a/again.json', content: JSON.stringify({ id: 'Alpha', main_file: 'a.lua' }) },
				{ path: 'c.lua', content: HEADER_MOD },
				{ path: 'bad.json', content: JSON.stringify({ id: 'has space', main_file: 'x.lua' }) },
			]),
		).toEqual(['Alpha', 'Bravo', 'OldStyle'])
	})
	it('reads a folder as deployed', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmp-smods-ids-'))
		try {
			await fs.mkdir(path.join(root, 'nested'), { recursive: true })
			await fs.writeFile(path.join(root, 'MultiplayerAPI.json'), MPAPI_MANIFEST)
			await fs.writeFile(path.join(root, 'nested', 'old.lua'), HEADER_MOD)
			await fs.writeFile(path.join(root, 'nested', 'image.png'), 'not text')
			expect(await readSmodsIds(root)).toEqual(['MultiplayerAPI', 'OldStyle'])
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})

describe("an admin's SMODS id override", () => {
	it('trims, dedupes and sorts', () => {
		expect(parseSmodsIdsOverride([' B ', 'A', 'B'])).toEqual(['A', 'B'])
		expect(parseSmodsIdsOverride([])).toEqual([])
	})
	it('refuses anything that is not a list of ids', () => {
		expect(parseSmodsIdsOverride('A')).toBeNull()
		expect(parseSmodsIdsOverride(['ok', 3])).toBeNull()
		expect(parseSmodsIdsOverride(['two words'])).toBeNull()
		expect(parseSmodsIdsOverride([''])).toBeNull()
	})
})
