import { describe, expect, it } from 'vitest'
import { loadConfig } from './env.js'
import { LADDERS } from './ladders.js'

const ROLES = [
	'STONE',
	'STEEL',
	'GOLD',
	'LUCKY',
	'GLASS',
	'NEGATIVE',
	'POLYCHROME',
	'HOLOGRAPHIC',
	'FOIL',
]

function fullEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		DISCORD_BOT_TOKEN: 'token',
		DISCORD_BOT_CLIENT_ID: '100000000000000001',
		DISCORD_GUILD_ID: '100000000000000002',
		DISCORD_BOT_API_KEY: 'key',
	}
	ROLES.forEach((role, i) => {
		env[`DISCORD_ROLE_${role}`] = String(200000000000000000n + BigInt(i))
	})
	return env
}

describe('loadConfig', () => {
	it('reads a full config with safe defaults', () => {
		const result = loadConfig(fullEnv(), LADDERS)
		if (!result.ok) throw new Error(result.problems.join())
		expect(result.config.dryRun).toBe(true)
		expect(result.config.syncIntervalMs).toBe(10 * 60_000)
		expect(result.config.apiUrl).toBe('http://api:8788')
		expect(result.config.roleIds.gold).toBe('200000000000000002')
		expect(Object.keys(result.config.roleIds)).toHaveLength(ROLES.length)
	})

	it('lists every missing variable in one problem', () => {
		const env = { ...fullEnv(), DISCORD_BOT_TOKEN: '', DISCORD_ROLE_FOIL: ' ' }
		expect(loadConfig(env, LADDERS)).toEqual({
			ok: false,
			problems: ['missing DISCORD_BOT_TOKEN, DISCORD_ROLE_FOIL'],
		})
	})

	it('rejects a role id that is not a snowflake', () => {
		const result = loadConfig(
			{ ...fullEnv(), DISCORD_ROLE_GOLD: '@Gold' },
			LADDERS,
		)
		expect(result).toEqual({
			ok: false,
			problems: ['invalid DISCORD_ROLE_GOLD'],
		})
	})

	it('rejects two roles with the same id', () => {
		const env = fullEnv()
		env.DISCORD_ROLE_STEEL = env.DISCORD_ROLE_STONE
		expect(loadConfig(env, LADDERS)).toEqual({
			ok: false,
			problems: [
				'invalid DISCORD_ROLE_STEEL (same role as DISCORD_ROLE_STONE)',
			],
		})
	})

	it.each([
		['false', false],
		['0', false],
		['FALSE', false],
		['true', true],
		['no', true],
		['', true],
	])('DRY_RUN=%j -> %s', (value, dryRun) => {
		const result = loadConfig({ ...fullEnv(), DRY_RUN: value }, LADDERS)
		expect(result.ok && result.config.dryRun).toBe(dryRun)
	})

	it('reads the interval and the API URL', () => {
		const result = loadConfig(
			{
				...fullEnv(),
				SYNC_INTERVAL_MINUTES: '30',
				BMP_API_URL: 'http://localhost:8788/',
			},
			LADDERS,
		)
		if (!result.ok) throw new Error(result.problems.join())
		expect(result.config.syncIntervalMs).toBe(30 * 60_000)
		expect(result.config.apiUrl).toBe('http://localhost:8788')
	})

	it('rejects an interval under a minute', () => {
		expect(
			loadConfig({ ...fullEnv(), SYNC_INTERVAL_MINUTES: '0' }, LADDERS),
		).toEqual({
			ok: false,
			problems: ['invalid SYNC_INTERVAL_MINUTES'],
		})
	})
})
