import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = [
	'BMP_SERVER_KIND',
	'DEV_AUTO_VERIFY_LAUNCHER',
	'DEV_FAKE_LAUNCHER_STRATEGY',
	'ALLOW_DEVICE_AUTH',
]
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

// env.ts reads process.env once, when it is first imported.
async function loadEnv(vars: { [key: string]: string }) {
	for (const key of KEYS) delete process.env[key]
	Object.assign(process.env, vars)
	vi.resetModules()
	return (await import('../env.js')).env
}

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key]
		else process.env[key] = saved[key]
	}
	vi.resetModules()
})

describe('API server kind', () => {
	it('is the Official server with every dev flag off when nothing is set', async () => {
		const env = await loadEnv({})
		expect(env.BMP_SERVER_KIND).toBe('official')
		expect(env.DEV_AUTO_VERIFY_LAUNCHER).toBe(false)
		expect(env.DEV_FAKE_LAUNCHER_STRATEGY).toBe(false)
	})

	it.each([
		'DEV_AUTO_VERIFY_LAUNCHER',
		'DEV_FAKE_LAUNCHER_STRATEGY',
		'ALLOW_DEVICE_AUTH',
	])('refuses to start as the Official server with %s on', async (flag) => {
		await expect(
			loadEnv({ BMP_SERVER_KIND: 'official', [flag]: 'true' }),
		).rejects.toThrow(flag)
	})

	it('turns the launcher dev flags on for a Dev server', async () => {
		const env = await loadEnv({
			BMP_SERVER_KIND: 'dev',
			DEV_AUTO_VERIFY_LAUNCHER: 'true',
			DEV_FAKE_LAUNCHER_STRATEGY: '1',
		})
		expect(env.DEV_AUTO_VERIFY_LAUNCHER).toBe(true)
		expect(env.DEV_FAKE_LAUNCHER_STRATEGY).toBe(true)
	})
})
