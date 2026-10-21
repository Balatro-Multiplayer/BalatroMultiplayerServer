import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig, readConfig, writeConfig } from '../config'
import { fakeLogger, fakeNk } from '../testing/fake_nk'
import { EXTRA_SEED_ENV, seedAllowedModIdsExtra } from './seed'

describe('seedAllowedModIdsExtra', () => {
	it('adds the env ids to the stored extra ids, keeping the rest of the config', () => {
		const nk = fakeNk()
		writeConfig(nk as any, { ...DEFAULT_CONFIG, season: 2, queueAllowedModIds: ['MultiplayerAPI'], queueAllowedModIdsExtra: ['Talisman'] })
		seedAllowedModIdsExtra(nk as any, fakeLogger, { [EXTRA_SEED_ENV]: 'MultiplayerPvP,ClaudeControl' })
		expect(readConfig(nk as any)).toMatchObject({
			season: 2,
			queueAllowedModIds: ['MultiplayerAPI'],
			queueAllowedModIdsExtra: ['Talisman', 'MultiplayerPvP', 'ClaudeControl'],
		})
	})
	it('survives an API push, and a second boot changes nothing', () => {
		const nk = fakeNk()
		const env = { [EXTRA_SEED_ENV]: 'MultiplayerPvP ClaudeControl' }
		seedAllowedModIdsExtra(nk as any, fakeLogger, env)
		writeConfig(nk as any, mergeConfig(readConfig(nk as any), { queueAllowedModIds: ['MultiplayerSPDRN'] }))
		const version = nk.objects.get('server_config/00000000-0000-0000-0000-000000000000/global')?.version
		seedAllowedModIdsExtra(nk as any, fakeLogger, env)
		expect(nk.objects.get('server_config/00000000-0000-0000-0000-000000000000/global')?.version).toBe(version)
		expect(readConfig(nk as any).queueAllowedModIdsExtra).toEqual(['MultiplayerPvP', 'ClaudeControl'])
	})
	it('writes nothing when the env is unset or malformed (a real server)', () => {
		const envs: { [key: string]: string }[] = [{}, { [EXTRA_SEED_ENV]: '' }, { [EXTRA_SEED_ENV]: 'x'.repeat(200) }]
		for (const env of envs) {
			const nk = fakeNk()
			seedAllowedModIdsExtra(nk as any, fakeLogger, env)
			expect(nk.objects.size).toBe(0)
		}
	})
})
