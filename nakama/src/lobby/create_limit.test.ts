import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import {
	CREATE_LIMIT,
	CREATE_WINDOW_MS,
	createTimesAfter,
} from './create_limit'
import { rpcLobbyCreate } from './rpc'

describe('createTimesAfter', () => {
	it('allows up to the limit within the window, then refuses', () => {
		let times: number[] = []
		for (let i = 0; i < CREATE_LIMIT; i++) {
			const next = createTimesAfter(times, 1000 + i)
			expect(next).not.toBeNull()
			times = next as number[]
		}
		expect(createTimesAfter(times, 1000 + CREATE_LIMIT)).toBeNull()
	})

	it('forgets creations older than the window', () => {
		const old = Array.from({ length: CREATE_LIMIT }, (_, i) => i)
		expect(createTimesAfter(old, CREATE_WINDOW_MS + CREATE_LIMIT)).toEqual([
			CREATE_WINDOW_MS + CREATE_LIMIT,
		])
	})
})

describe('lobby_create', () => {
	afterEach(() => vi.restoreAllMocks())

	it('refuses a player creating lobbies faster than the limit', () => {
		// Each created lobby runs a match for up to 30s even if nobody joins, and
		// the creator only counts as in it once joined: unlimited, one client
		// could keep hundreds of lobby matches running.
		let made = 0
		const nk: any = fakeNk({ matchCreate: () => `m${++made}.node` })
		const ctx: any = playerCtx('u1')
		vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
		for (let i = 0; i < CREATE_LIMIT; i++) {
			expect(
				JSON.parse(
					rpcLobbyCreate(ctx, fakeLogger, nk, JSON.stringify({ modId: 'M' })),
				).code,
			).toBeTruthy()
		}
		expect(() =>
			rpcLobbyCreate(ctx, fakeLogger, nk, JSON.stringify({ modId: 'M' })),
		).toThrow(/Too many lobbies/)
		expect(made).toBe(CREATE_LIMIT)
		// Another player is not affected.
		expect(() =>
			rpcLobbyCreate(
				playerCtx('u2') as any,
				fakeLogger,
				nk,
				JSON.stringify({ modId: 'M' }),
			),
		).not.toThrow()
	})
})
