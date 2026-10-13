import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'
import { nakamaConfigOf, pushConfigToNakama, setIntegrityEnforced } from '../../infrastructure/nakama/config-sync.js'
import type { AppConfig } from '../../state/config.js'

const config: AppConfig = {
	tosVersion: 4,
	mods: [],
	chatAllowlist: new Set(),
	chatEnabled: false,
	testingMode: undefined,
	rankedEnabled: true,
	casualQueueEnabled: false,
	lobbyCreationEnabled: true,
}

describe('pushing config to Nakama', () => {
	const fetchMock = vi.fn()
	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock)
		fetchMock.mockReset()
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		env.NAKAMA_URL = ''
		env.NAKAMA_HTTP_KEY = ''
	})

	it('maps the switches Nakama enforces', () => {
		expect(nakamaConfigOf(config)).toEqual({
			tosVersion: 4,
			chatEnabled: false,
			rankedEnabled: true,
			casualQueueEnabled: false,
			lobbyCreationEnabled: true,
			testingMode: false,
			integrityEnforced: false,
		})
		setIntegrityEnforced(true)
		expect(nakamaConfigOf(config).integrityEnforced).toBe(true)
		setIntegrityEnforced(false)
	})

	it('is dormant without a Nakama URL and http key', async () => {
		expect(await pushConfigToNakama(config)).toBe(false)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('calls admin_config_set with the http key', async () => {
		env.NAKAMA_URL = 'http://nakama:7350'
		env.NAKAMA_HTTP_KEY = 'hk'
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
		expect(await pushConfigToNakama(config)).toBe(true)
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe('http://nakama:7350/v2/rpc/admin_config_set?http_key=hk&unwrap')
		expect(JSON.parse(init.body)).toEqual(nakamaConfigOf(config))
	})

	it('retries while Nakama is unreachable', async () => {
		vi.useFakeTimers()
		env.NAKAMA_URL = 'http://nakama:7350'
		env.NAKAMA_HTTP_KEY = 'hk'
		fetchMock.mockRejectedValueOnce(new Error('down')).mockResolvedValue(new Response('{}', { status: 200 }))
		expect(await pushConfigToNakama(config)).toBe(false)
		await vi.advanceTimersByTimeAsync(2000)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})
})
