import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkThunderstoreVersion } from '../../features/mods/thunderstore-version-check.js'

const INDEX_URL = 'https://thunderstore.io/c/balatro/api/v1/package/'
const DOWNLOAD_URL =
	'https://thunderstore.io/package/download/BalatroMultiplayer/MultiplayerAPI/1.2.3/'
const FULL_NAME = 'BalatroMultiplayer-MultiplayerAPI'

function stubThunderstore(opts: {
	index: Response | Error
	download?: number
}) {
	const fetchMock = vi.fn(async (url: string) => {
		if (url === INDEX_URL) {
			if (opts.index instanceof Error) throw opts.index
			return opts.index
		}
		if (url === DOWNLOAD_URL)
			return new Response(null, { status: opts.download ?? 200 })
		throw new Error(`unexpected fetch ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status })
const pkg = (versions: object[], extra: object = {}) => ({
	full_name: FULL_NAME,
	is_active: true,
	versions,
	...extra,
})
const v123 = {
	version_number: '1.2.3',
	is_active: true,
	download_url: DOWNLOAD_URL,
}

afterEach(() => vi.unstubAllGlobals())

describe('checkThunderstoreVersion', () => {
	it('is up when the community list has the version and its download works', async () => {
		stubThunderstore({ index: json([pkg([v123])]) })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('up')
	})

	it('is not up while the package is missing from the community list (in review)', async () => {
		stubThunderstore({
			index: json([{ full_name: 'Other-Mod', versions: [] }]),
		})
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
	})

	it('is not up when the list has only older versions', async () => {
		stubThunderstore({
			index: json([pkg([{ ...v123, version_number: '1.2.2' }])]),
		})
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
	})

	it('is not up when the package or the version is inactive', async () => {
		stubThunderstore({ index: json([pkg([v123], { is_active: false })]) })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
		stubThunderstore({ index: json([pkg([{ ...v123, is_active: false }])]) })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
	})

	it('is not up when the download fails', async () => {
		stubThunderstore({ index: json([pkg([v123])]), download: 404 })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
	})

	it('is not up on an error answer, odd body or network error', async () => {
		stubThunderstore({ index: json({}, 429) })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
		stubThunderstore({ index: json({ not: 'a list' }) })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
		stubThunderstore({ index: new Error('offline') })
		expect(await checkThunderstoreVersion(FULL_NAME, '1.2.3')).toBe('not-up')
	})
})
