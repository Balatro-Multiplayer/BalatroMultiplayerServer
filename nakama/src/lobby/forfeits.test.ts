import { describe, expect, it } from 'vitest'
import { rpcAdminMirrorPull } from '../admin'
import { fakeLogger, fakeNk, serverCtx } from '../testing/fake_nk'
import { FORFEITS_COLLECTION, RECONCILIATION_WINDOW_MS, noteReturn, recordForfeit } from './forfeits'
import { type Lobby, disconnect, join, newLobby, tick } from './state'

const info = (name: string) => ({ displayName: name, preferredJoker: null, mods: null })

function startedLobby(gameMode?: string): Lobby {
	let lobby = newLobby({ code: 'ABCDE', modId: 'M', maxPlayers: 2, creatorId: 'a', now: 0, graceMs: 10_000, gameMode })
	lobby = join(lobby, 'a', 'a-s', info('a')).lobby
	lobby = join(lobby, 'b', 'b-s', info('b')).lobby
	const players = [
		{ id: 'a', displayName: 'a' },
		{ id: 'b', displayName: 'b' },
	]
	return { ...lobby, game: { ...lobby.game, started: { runId: 'r1', hostId: 'a', players } as never } }
}

describe('timing out of a game', () => {
	it('is recorded for a matchmade game only', () => {
		for (const [gameMode, expected] of [
			['duel', [{ kind: 'forfeited', userId: 'b', runId: 'r1', code: 'ABCDE', at: 10_000 }]],
			[undefined, []],
		] as const) {
			const away = disconnect(startedLobby(gameMode), 'b', 'b-s', 0).lobby
			const out = tick(away, 10_000).out.filter((o) => o.kind === 'forfeited')
			expect(out).toEqual(expected)
		}
	})

	it('is filed for review when the player is back in time, then forgotten', () => {
		const nk: any = fakeNk({ uuidv4: () => 'u1', accountGetId: () => ({ customId: '' }) })
		recordForfeit(nk, 'b', { runId: 'r1', code: 'ABCDE', at: 1000 })
		recordForfeit(nk, 'b', { runId: 'r0', code: 'OLDER', at: 1000 - RECONCILIATION_WINDOW_MS })
		noteReturn(nk, fakeLogger, 'b', 1000 + RECONCILIATION_WINDOW_MS - 1)
		const { entries } = JSON.parse(rpcAdminMirrorPull(serverCtx(), fakeLogger, nk, '{}'))
		expect(entries).toEqual([
			expect.objectContaining({ kind: 'forfeit', userId: 'b', runId: 'r1', code: 'ABCDE', forfeitedAt: 1000 }),
		])
		expect([...nk.objects.keys()].some((k: string) => k.startsWith(FORFEITS_COLLECTION))).toBe(false)
	})
})
