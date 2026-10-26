// Test data for a Community or Dev server (compose.local.yml's `seed`
// service): Nakama accounts the Dev mod can log in as, and a web admin with a
// login link, since the website's own login is Steam only. Safe to run again:
// the same device ids give the same accounts and the admin row is upserted.
// Never on the Official server.
import type { ServerKind } from '@bmp/types'
import { type Result, err, ok } from '../../shared/utils/result.js'

// The Dev mod logs in with device id `bmp-dev-<BMP_IMPERSONATE_NAME>`
// (MPAPI networking/connection.lua), so BMP_IMPERSONATE_NAME=TestPlayer1
// is the first account here.
const DEV_DEVICE_PREFIX = 'bmp-dev-'
const TEST_PLAYER_NAMES = [
	'TestPlayer1',
	'TestPlayer2',
	'TestPlayer3',
	'TestPlayer4',
]

// Fixed, so a second seed updates the same row instead of adding one.
export const LOCAL_ADMIN = {
	id: '00000000-0000-4000-8000-00000000a0a0',
	steamName: 'LocalAdmin',
} as const

export interface TestPlayer {
	deviceId: string
	username: string
}

export interface WebAdmin {
	id: string
	steamName: string
}

export interface SeedDeps {
	kind: ServerKind
	webBaseUrl: string
	createTestPlayer(
		player: TestPlayer,
	): Promise<Result<{ userId: string }, string>>
	upsertWebAdmin(admin: WebAdmin): Promise<void>
	signAdminToken(admin: WebAdmin): string
}

export interface SeedReport {
	players: (TestPlayer & { userId: string })[]
	adminLoginUrl: string
}

export type SeedError =
	| { kind: 'official_server' }
	| { kind: 'player_failed'; username: string; reason: string }

export async function runSeed(
	deps: SeedDeps,
): Promise<Result<SeedReport, SeedError>> {
	if (deps.kind === 'official') return err({ kind: 'official_server' })

	const players: SeedReport['players'] = []
	for (const username of TEST_PLAYER_NAMES) {
		const player = { deviceId: `${DEV_DEVICE_PREFIX}${username}`, username }
		const created = await deps.createTestPlayer(player)
		if (!created.ok)
			return err({ kind: 'player_failed', username, reason: created.error })
		players.push({ ...player, userId: created.value.userId })
	}

	await deps.upsertWebAdmin(LOCAL_ADMIN)
	const token = deps.signAdminToken(LOCAL_ADMIN)
	const base = deps.webBaseUrl.replace(/\/+$/, '')
	return ok({
		players,
		adminLoginUrl: `${base}/auth/callback?token=${encodeURIComponent(token)}`,
	})
}
