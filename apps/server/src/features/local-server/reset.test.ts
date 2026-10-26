import { describe, expect, it } from 'vitest'
import { type ResetDeps, runReset } from './reset.js'

function fakeDeps(overrides: Partial<ResetDeps> = {}) {
	const steps: string[] = []
	const deps: ResetDeps = {
		kind: 'dev',
		apiDatabase: 'bmp',
		nakamaDatabase: 'nakama',
		dropDatabase: async (name) => {
			steps.push(`drop ${name}`)
		},
		createDatabase: async (name) => {
			steps.push(`create ${name}`)
		},
		migrate: async () => {
			steps.push('migrate')
		},
		...overrides,
	}
	return { deps, steps }
}

describe('runReset', () => {
	it('empties both databases and leaves the API database migrated', async () => {
		const { deps, steps } = fakeDeps()

		const result = await runReset(deps)

		expect(result.ok).toBe(true)
		// Nakama's `migrate up` makes its own database again at its next start.
		expect(steps).toEqual(['drop nakama', 'drop bmp', 'create bmp', 'migrate'])
	})

	it('refuses the Official server and changes nothing', async () => {
		const { deps, steps } = fakeDeps({ kind: 'official' })

		const result = await runReset(deps)

		expect(result).toEqual({ ok: false, error: { kind: 'official_server' } })
		expect(steps).toEqual([])
	})
})
