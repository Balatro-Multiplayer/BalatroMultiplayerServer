import { describe, expect, it } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { lobbyMatchInit, lobbyMatchJoin, lobbyMatchJoinAttempt } from './match'

// A deleted account's session token stays valid until it expires (Nakama),
// so its socket can still try to join a lobby.
const DELETED = 'deleted-user'

function lobbyNk(overrides: { [key: string]: unknown } = {}) {
	return fakeNk({
		accountGetId: (id: string) => {
			if (id === DELETED) throw new Error('account not found')
			return { user: { userId: id, username: id } }
		},
		matchGet: () => null,
		...overrides,
	}) as unknown as nkruntime.Nakama
}

function created(nk: nkruntime.Nakama) {
	const ctx = { ...playerCtx(''), matchId: 'm1' } as nkruntime.Context
	const init = lobbyMatchInit(ctx, fakeLogger, nk, {
		code: 'ABC123',
		modId: 'M',
		maxPlayers: 4,
		creatorId: 'host',
	})
	return { ctx, state: init.state }
}

const presence = (userId: string) =>
	({
		userId,
		sessionId: `${userId}-s`,
		username: userId,
		node: 'n',
	}) as nkruntime.Presence
const dispatcher = {
	broadcastMessage: () => undefined,
	matchKick: () => undefined,
	matchLabelUpdate: () => undefined,
} as unknown as nkruntime.MatchDispatcher

describe('joining as a deleted account', () => {
	it('is refused', () => {
		const nk = lobbyNk()
		const { ctx, state } = created(nk)
		const attempt = lobbyMatchJoinAttempt(
			ctx,
			fakeLogger,
			nk,
			dispatcher,
			1,
			state,
			presence(DELETED),
			{ modId: 'M' },
		)
		expect(attempt.accept).toBe(false)
		expect(attempt.rejectMessage).toBe('No such account')
	})

	it('lets a live account in', () => {
		const nk = lobbyNk()
		const { ctx, state } = created(nk)
		expect(
			lobbyMatchJoinAttempt(
				ctx,
				fakeLogger,
				nk,
				dispatcher,
				1,
				state,
				presence('host'),
				{ modId: 'M' },
			).accept,
		).toBe(true)
	})
})

describe('a failed current-lobby write on join', () => {
	it('does not stop the match', () => {
		const nk = lobbyNk({
			storageWrite: () => {
				throw new Error('violates foreign key constraint')
			},
		})
		const { ctx, state } = created(nk)
		const attempt = lobbyMatchJoinAttempt(
			ctx,
			fakeLogger,
			nk,
			dispatcher,
			1,
			state,
			presence('host'),
			{ modId: 'M' },
		)
		const joined = lobbyMatchJoin(
			ctx,
			fakeLogger,
			nk,
			dispatcher,
			2,
			attempt.state,
			[presence('host')],
		)
		expect(joined).not.toBeNull()
		expect(joined?.state.lobby.players.map((p) => p.id)).toEqual(['host'])
	})
})
