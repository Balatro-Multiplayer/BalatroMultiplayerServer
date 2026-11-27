import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkThunderstoreVersion } from '../../features/mods/thunderstore-version-check.js'

const VERSION_URL =
	'https://thunderstore.io/api/experimental/package/BalatroMultiplayer/MultiplayerAPI/1.2.3/'
const DOWNLOAD_URL =
	'https://thunderstore.io/package/download/BalatroMultiplayer/MultiplayerAPI/1.2.3/'

function stubThunderstore(opts: {
	page: Response | Error
	download?: number
}) {
	const fetchMock = vi.fn(async (url: string) => {
		if (url === VERSION_URL) {
			if (opts.page instanceof Error) throw opts.page
			return opts.page
		}
		if (url === DOWNLOAD_URL)
			return new Response(null, { status: opts.download ?? 200 })
		throw new Error(`unexpected fetch ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}
const page = (body: object, status = 200) =>
	new Response(JSON.stringify(body), { status })

afterEach(() => vi.unstubAllGlobals())

describe('checkThunderstoreVersion', () => {
	it('is up when the version page answers and its download works', async () => {
		stubThunderstore({
			page: page({
				version_number: '1.2.3',
				is_active: true,
				download_url: DOWNLOAD_URL,
			}),
		})
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('up')
	})

	it('is not up while the version page is a 404 (waiting for approval)', async () => {
		const fetchMock = stubThunderstore({ page: page({}, 404) })
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('not-up')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('is not up when the page answers but the download does not', async () => {
		stubThunderstore({
			page: page({ version_number: '1.2.3', download_url: DOWNLOAD_URL }),
			download: 404,
		})
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('not-up')
	})

	it('is not up for another version, an inactive version or a network error', async () => {
		stubThunderstore({ page: page({ version_number: '1.2.2' }) })
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('not-up')
		stubThunderstore({
			page: page({ version_number: '1.2.3', is_active: false }),
		})
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('not-up')
		stubThunderstore({ page: new Error('offline') })
		expect(
			await checkThunderstoreVersion(
				'BalatroMultiplayer-MultiplayerAPI',
				'1.2.3',
			),
		).toBe('not-up')
	})
})
