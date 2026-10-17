import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { lobbyMatchLeave, lobbyMatchLoop, lobbyMatchSignal } from './match'
import { MY_RUNS_COLLECTION, RUNS_COLLECTION } from './protocol'
import { type Lobby, join, newLobby } from './state'

const info = (name: string) => ({ displayName: name, preferredJoker: null, mods: null })

function startedLobby(): Lobby {
	let lobby = newLobby({ code: 'ABC123', modId: 'M', maxPlayers: 4, creatorId: 'a', now: 0, graceMs: 10_000 })
	lobby = join(lobby, 'a', 'a-s', info('a')).lobby
	lobby = join(lobby, 'b', 'b-s', info('b')).lobby
	const players = lobby.players.map((p) => ({ id: p.id, displayName: p.info.displayName }))
	return {
		...lobby,
		game: {
			...lobby.game,
			started: { runId: 'r1', hostId: 'a', players, seed: 'S', stake: 1, options: {}, startedAt: 1 } as never,
		},
	}
}

const keys = (nk: any, collection: string, userId: string) =>
	[...nk.objects.keys()].filter((k: string) => k.startsWith(`${collection}/${userId}/`))

describe('a lobby closed by a signal', () => {
	afterEach(() => vi.restoreAllMocks())

	it('stores its game once, not again at the next loop', () => {
		const nk: any = fakeNk({ sha256Hash: (s: string) => `h${s.length}`, matchLabelUpdate: () => {} })
		const dispatcher: any = { broadcastMessage: () => {}, matchKick: () => {}, matchLabelUpdate: () => {} }
		const ctx: any = { ...playerCtx(''), matchId: 'm1' }
		let state: any = { lobby: startedLobby(), presences: {}, pendingInfo: {}, label: '' }
		for (const userId of ['b', 'a']) {
			state = lobbyMatchSignal(ctx, fakeLogger, nk, dispatcher, 1, state, JSON.stringify({ type: 'leave', userId })).state
		}
		expect(state.lobby.closed).toBe(true)
		expect(keys(nk, MY_RUNS_COLLECTION, 'a')).toHaveLength(1)
		expect(lobbyMatchLoop(ctx, fakeLogger, nk, dispatcher, 2, state, [])).toBeNull()
		expect(keys(nk, MY_RUNS_COLLECTION, 'a')).toHaveLength(1)
		expect(keys(nk, MY_RUNS_COLLECTION, 'b')).toHaveLength(1)
		expect([...nk.objects.keys()].filter((k: string) => k.startsWith(`${RUNS_COLLECTION}/`))).toHaveLength(1)
	})

	it('stores its game once when the kicked leaver presence leaves after the signal', () => {
		// leave() kicks the leaver's presence; Nakama then calls matchLeave with
		// the stale (pre-close) state the signal handed back, before the next loop.
		// my_runs keys carry endedAt: let the clock move so a second save shows.
		let clock = 1_000
		vi.spyOn(Date, 'now').mockImplementation(() => (clock += 7))
		const nk: any = fakeNk({ sha256Hash: (s: string) => `h${s.length}`, matchLabelUpdate: () => {} })
		const dispatcher: any = { broadcastMessage: () => {}, matchKick: () => {}, matchLabelUpdate: () => {} }
		const ctx: any = { ...playerCtx(''), matchId: 'm1' }
		const presence = (userId: string) => ({ userId, sessionId: `${userId}-s`, username: userId, node: 'n' })
		let state: any = { lobby: startedLobby(), presences: { a: presence('a'), b: presence('b') }, pendingInfo: {}, label: '' }
		for (const userId of ['b', 'a']) {
			state = lobbyMatchSignal(ctx, fakeLogger, nk, dispatcher, 1, state, JSON.stringify({ type: 'leave', userId })).state
		}
		expect(keys(nk, MY_RUNS_COLLECTION, 'a')).toHaveLength(1)
		expect(lobbyMatchLeave(ctx, fakeLogger, nk, dispatcher, 2, state, [presence('a') as never])).toBeNull()
		expect(keys(nk, MY_RUNS_COLLECTION, 'a')).toHaveLength(1)
		expect([...nk.objects.keys()].filter((k: string) => k.startsWith(`${RUNS_COLLECTION}/`))).toHaveLength(1)
	})
})
