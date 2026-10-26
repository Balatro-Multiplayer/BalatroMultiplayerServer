import { describe, expect, it } from 'vitest'
import { serverKindErrorMessage, serverSettings } from './server_kind'

const settings = (env: { [key: string]: string }) => {
	const result = serverSettings(env)
	if (!result.ok) throw new Error(serverKindErrorMessage(result.error))
	return result.value
}

describe('server kind', () => {
	it('is the Official server when nothing is set: Steam login only, remote moderation on, allowed mods checked', () => {
		expect(settings({})).toEqual({
			kind: 'official',
			deviceLogin: false,
			rankedLobbies: false,
			autoVerifyLauncher: false,
			fakeLauncherStrategy: false,
			moderationRemote: true,
			testingRpcs: false,
			allowedModsChecked: true,
			networkBans: true,
		})
	})

	it.each([
		'ALLOW_DEVICE_AUTH',
		'ALLOW_RANKED_LOBBIES',
		'DEV_AUTO_VERIFY_LAUNCHER',
		'DEV_FAKE_LAUNCHER_STRATEGY',
	])('refuses to start the Official server with %s on', (flag) => {
		const result = serverSettings({
			BMP_SERVER_KIND: 'official',
			[flag]: 'true',
		})
		expect(result).toEqual({
			ok: false,
			error: { code: 'dev_flag_not_allowed', kind: 'official', flags: [flag] },
		})
		if (!result.ok) expect(serverKindErrorMessage(result.error)).toContain(flag)
	})

	it('also refuses an Official server with no kind set and a dev flag on', () => {
		expect(serverSettings({ ALLOW_DEVICE_AUTH: '1' }).ok).toBe(false)
	})

	it('lets the Official server carry a dev flag that is switched off', () => {
		expect(
			settings({
				BMP_SERVER_KIND: 'official',
				ALLOW_DEVICE_AUTH: 'false',
				DEV_AUTO_VERIFY_LAUNCHER: '',
			}).deviceLogin,
		).toBe(false)
	})

	it('turns Device login on for a Community server, judges chat locally and lets any mod queue', () => {
		expect(settings({ BMP_SERVER_KIND: 'community' })).toEqual({
			kind: 'community',
			deviceLogin: true,
			rankedLobbies: false,
			autoVerifyLauncher: false,
			fakeLauncherStrategy: false,
			moderationRemote: false,
			testingRpcs: false,
			allowedModsChecked: false,
			networkBans: false,
		})
	})

	it('lets a Community host turn remote moderation back on', () => {
		expect(
			settings({ BMP_SERVER_KIND: 'community', MODERATION_REMOTE: 'on' })
				.moderationRemote,
		).toBe(true)
	})

	it('refuses to start a Community server with a dev-only flag on', () => {
		const result = serverSettings({
			BMP_SERVER_KIND: 'community',
			ALLOW_RANKED_LOBBIES: 'true',
			DEV_AUTO_VERIFY_LAUNCHER: 'true',
		})
		expect(result).toEqual({
			ok: false,
			error: {
				code: 'dev_flag_not_allowed',
				kind: 'community',
				flags: ['ALLOW_RANKED_LOBBIES', 'DEV_AUTO_VERIFY_LAUNCHER'],
			},
		})
	})

	it('gives a Dev server Device login, ranked lobbies and testing RPCs by default', () => {
		expect(settings({ BMP_SERVER_KIND: 'dev' })).toEqual({
			kind: 'dev',
			deviceLogin: true,
			rankedLobbies: true,
			autoVerifyLauncher: false,
			fakeLauncherStrategy: false,
			moderationRemote: false,
			testingRpcs: true,
			allowedModsChecked: false,
			networkBans: false,
		})
	})

	it('lets single flags override a Dev server', () => {
		const dev = settings({
			BMP_SERVER_KIND: 'dev',
			ALLOW_RANKED_LOBBIES: 'false',
			DEV_AUTO_VERIFY_LAUNCHER: 'true',
			DEV_FAKE_LAUNCHER_STRATEGY: '1',
			MODERATION_REMOTE: 'on',
		})
		expect(dev.rankedLobbies).toBe(false)
		expect(dev.autoVerifyLauncher).toBe(true)
		expect(dev.fakeLauncherStrategy).toBe(true)
		expect(dev.moderationRemote).toBe(true)
	})

	it('refuses a kind it does not know', () => {
		const result = serverSettings({ BMP_SERVER_KIND: 'prod' })
		expect(result).toEqual({
			ok: false,
			error: { code: 'unknown_kind', value: 'prod' },
		})
		if (!result.ok)
			expect(serverKindErrorMessage(result.error)).toContain(
				'official, community, dev',
			)
	})
})
