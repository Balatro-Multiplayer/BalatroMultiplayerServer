import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../features/mods/mod-version-hash.js', () => ({
	inspectModRelease: vi.fn(),
}))

import { inspectModRelease } from '../../features/mods/mod-version-hash.js'
import { db } from '../../infrastructure/db/index.js'
import {
	setRankedVersion,
	setSmodsIds,
} from '../../infrastructure/gateways/mods.gateway.js'

// db.select() resolving to these rows, whatever the caller chains.
function rows(result: unknown[]): any {
	const chain: any = {}
	for (const method of ['from', 'where', 'orderBy', 'limit'])
		chain[method] = vi.fn(() => chain)
	chain.then = (resolve: (r: unknown[]) => void) => resolve(result)
	return chain
}

const mod = {
	id: 'Alice-Mod',
	thunderstoreFullName: 'Alice-Mod',
	repoUrl: null,
	rankedVersion: '1.0.0',
}
const version = {
	modId: 'Alice-Mod',
	version: '2.0.0',
	source: 'thunderstore',
	ref: null,
	downloadUrl: 'https://ts/Alice-Mod/2.0.0/',
	aliases: [],
}

let stored: Record<string, unknown>[]

beforeEach(() => {
	stored = []
	vi.mocked(db.update).mockReturnValue({
		set: vi.fn((values: Record<string, unknown>) => {
			stored.push(values)
			return { where: vi.fn().mockResolvedValue(undefined) }
		}),
	} as any)
})

describe('a pin change (mods.gateway.ts)', () => {
	it('stores the ids read from the new version, marked as read for it', async () => {
		vi.mocked(db.select)
			.mockReturnValueOnce(rows([mod]))
			.mockReturnValueOnce(rows([version]))
		vi.mocked(inspectModRelease).mockResolvedValue({
			hash: 'h'.repeat(64),
			smodsIds: ['AliceMod'],
		})

		expect(await setRankedVersion('Alice-Mod', '2.0.0')).toEqual({ ok: true })

		expect(stored).toHaveLength(1)
		expect(stored[0]).toMatchObject({
			rankedVersion: '2.0.0',
			smodsIds: ['AliceMod'],
			smodsIdsReadVersion: '2.0.0',
		})
	})

	it('marks ids an admin set as read, so the boot backfill never overwrites them', async () => {
		vi.mocked(db.select).mockReturnValueOnce(rows([mod]))

		expect(await setSmodsIds('Alice-Mod', [])).toEqual({ ok: true })

		expect(stored[0]).toMatchObject({
			smodsIds: [],
			smodsIdsReadVersion: '1.0.0',
		})
	})

	it('clears the read mark when the mod is un-ranked', async () => {
		vi.mocked(db.select).mockReturnValueOnce(rows([mod]))

		expect(await setRankedVersion('Alice-Mod', null)).toEqual({ ok: true })

		expect(stored[0]).toMatchObject({
			rankedVersion: null,
			smodsIds: [],
			smodsIdsReadVersion: null,
		})
	})
})
