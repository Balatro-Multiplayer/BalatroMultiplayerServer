import { describe, expect, it } from 'vitest'
import { type SeedDeps, runSeed } from './seed.js'

function fakeDeps(overrides: Partial<SeedDeps> = {}) {
	const created: { deviceId: string; username: string }[] = []
	const admins: { id: string; steamName: string }[] = []
	const deps: SeedDeps = {
		kind: 'dev',
		webBaseUrl: 'http://127.0.0.1:3000',
		createTestPlayer: async (player) => {
			created.push(player)
			return { ok: true, value: { userId: `user-${player.username}` } }
		},
		upsertWebAdmin: async (admin) => {
			admins.push(admin)
		},
		signAdminToken: (admin) => `token-for-${admin.id}`,
		...overrides,
	}
	return { deps, created, admins }
}

describe('runSeed', () => {
	it('makes four test players the Dev mod can log in as', async () => {
		const { deps, created } = fakeDeps()

		const result = await runSeed(deps)

		expect(result.ok).toBe(true)
		expect(created).toEqual([
			{ deviceId: 'bmp-dev-TestPlayer1', username: 'TestPlayer1' },
			{ deviceId: 'bmp-dev-TestPlayer2', username: 'TestPlayer2' },
			{ deviceId: 'bmp-dev-TestPlayer3', username: 'TestPlayer3' },
			{ deviceId: 'bmp-dev-TestPlayer4', username: 'TestPlayer4' },
		])
	})

	it('makes a web admin and gives a login link for it', async () => {
		const { deps, admins } = fakeDeps()

		const result = await runSeed(deps)

		expect(admins).toEqual([
			{ id: '00000000-0000-4000-8000-00000000a0a0', steamName: 'LocalAdmin' },
		])
		expect(result.ok && result.value.adminLoginUrl).toBe(
			'http://127.0.0.1:3000/auth/callback?token=token-for-00000000-0000-4000-8000-00000000a0a0',
		)
	})

	it('works on a Community server too', async () => {
		const { deps } = fakeDeps({ kind: 'community' })

		expect((await runSeed(deps)).ok).toBe(true)
	})

	it('refuses the Official server and changes nothing', async () => {
		const { deps, created, admins } = fakeDeps({ kind: 'official' })

		const result = await runSeed(deps)

		expect(result).toEqual({ ok: false, error: { kind: 'official_server' } })
		expect(created).toEqual([])
		expect(admins).toEqual([])
	})

	it('names the test player Nakama refused', async () => {
		const { deps } = fakeDeps({
			createTestPlayer: async (player) =>
				player.username === 'TestPlayer2'
					? { ok: false, error: 'connection refused' }
					: { ok: true, value: { userId: 'u' } },
		})

		const result = await runSeed(deps)

		expect(result).toEqual({
			ok: false,
			error: {
				kind: 'player_failed',
				username: 'TestPlayer2',
				reason: 'connection refused',
			},
		})
	})
})
