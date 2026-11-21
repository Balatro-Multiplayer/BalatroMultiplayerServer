import { describe, expect, it, vi } from 'vitest'
import {
	type ChangesAnswer,
	type ChangesRequest,
	type StandingsAnswer,
	type StandingsRequest,
	createChangesClient,
	createStandingsClient,
} from './standings-client.js'

const API = 'http://api:8788'
const KEY = 'test-key'

const request: StandingsRequest = {
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
	topN: 50,
	discordIds: ['123456789012345678'],
}

const answer: StandingsAnswer = {
	season: 3,
	previousSeason: 2,
	players: {
		'123456789012345678': {
			playerId: 'p-1',
			current: { gamesPlayed: 7, rating: 812 },
			previous: null,
		},
	},
	top: ['p-1'],
}

// A fetch that answers every call with this status and body, and records it.
function fakeFetch(status: number, body: unknown) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status,
			}),
	)
}

describe('createStandingsClient', () => {
	it('POSTs the request as JSON with the internal key', async () => {
		const fetchImpl = fakeFetch(200, answer)
		await createStandingsClient(API, KEY, fetchImpl)(request)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(`${API}/internal/discord-bot/standings`)
		expect(init?.method).toBe('POST')
		expect(init?.headers).toEqual({
			'content-type': 'application/json',
			'x-bmp-internal-key': KEY,
		})
		expect(JSON.parse(init?.body as string)).toEqual(request)
		// A hung API must not hold a sweep forever.
		expect(init?.signal).toBeInstanceOf(AbortSignal)
	})

	it('returns the answer as sent', async () => {
		const fetch = createStandingsClient(API, KEY, fakeFetch(200, answer))
		await expect(fetch(request)).resolves.toEqual(answer)
	})

	it('accepts an answer with nobody linked and no top list', async () => {
		const empty = { season: 1, previousSeason: null, players: {}, top: [] }
		const fetch = createStandingsClient(API, KEY, fakeFetch(200, empty))
		await expect(fetch(request)).resolves.toEqual(empty)
	})

	it('fails with the status and the start of the body on an HTTP error', async () => {
		const fetch = createStandingsClient(
			API,
			KEY,
			fakeFetch(503, `{"error":"No active season"}${'x'.repeat(500)}`),
		)
		const err = await fetch(request).catch((e: Error) => e)
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toMatch(
			/^standings request failed: HTTP 503 \{"error":"No active season"\}x+$/,
		)
		// The body is cut to 200 characters so a huge error page can't flood the log.
		expect((err as Error).message.length).toBeLessThan(260)
	})

	it('still fails cleanly when the error body cannot be read', async () => {
		const res = new Response(null, { status: 401 })
		vi.spyOn(res, 'text').mockRejectedValue(new Error('stream broke'))
		const fetch = createStandingsClient(API, KEY, async () => res)
		await expect(fetch(request)).rejects.toThrow(
			'standings request failed: HTTP 401',
		)
	})

	it.each([
		['null', null],
		['an array', []],
		['no season', { ...answer, season: undefined }],
		['a text season', { ...answer, season: '3' }],
		['null players', { ...answer, players: null }],
		['no players', { ...answer, players: undefined }],
		['a top that is not a list', { ...answer, top: 'p-1' }],
		['no top', { ...answer, top: undefined }],
	])('rejects a malformed answer: %s', async (_name, body) => {
		const fetch = createStandingsClient(API, KEY, fakeFetch(200, body))
		await expect(fetch(request)).rejects.toThrow(
			'standings request failed: malformed answer',
		)
	})

	it('fails on an answer that is not JSON', async () => {
		const fetch = createStandingsClient(API, KEY, fakeFetch(200, '<html>'))
		await expect(fetch(request)).rejects.toThrow()
	})

	it('passes a network error through', async () => {
		const fetch = createStandingsClient(API, KEY, async () => {
			throw new TypeError('fetch failed')
		})
		await expect(fetch(request)).rejects.toThrow('fetch failed')
	})
})

describe('createChangesClient', () => {
	const changesRequest: ChangesRequest = {
		modId: 'MultiplayerPvP',
		gameMode: 'ranked:pvp_ranked_expanded',
		topN: 50,
		since: '2026-11-21T10:00:00.000Z',
	}
	const changes: ChangesAnswer = {
		season: 3,
		cursor: '2026-11-21T10:05:00.000Z',
		changed: [{ playerId: 'p-1', updatedAt: '2026-11-21T10:04:00.000Z' }],
		top: ['p-1'],
	}

	it('POSTs to /changes with the internal key and returns the answer', async () => {
		const fetchImpl = fakeFetch(200, changes)
		await expect(
			createChangesClient(API, KEY, fetchImpl)(changesRequest),
		).resolves.toEqual(changes)
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(`${API}/internal/discord-bot/changes`)
		expect(init?.method).toBe('POST')
		expect(
			(init?.headers as Record<string, string>)['x-bmp-internal-key'],
		).toBe(KEY)
		expect(JSON.parse(init?.body as string)).toEqual(changesRequest)
		expect(init?.signal).toBeInstanceOf(AbortSignal)
	})

	it('sends a null cursor on the first call', async () => {
		const fetchImpl = fakeFetch(200, { ...changes, changed: [] })
		await createChangesClient(
			API,
			KEY,
			fetchImpl,
		)({
			...changesRequest,
			since: null,
		})
		expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string).since).toBe(
			null,
		)
	})

	it('names /changes in an HTTP error', async () => {
		const fetch = createChangesClient(API, KEY, fakeFetch(503, 'down'))
		await expect(fetch(changesRequest)).rejects.toThrow(
			'changes request failed: HTTP 503 down',
		)
	})

	it.each([
		['null', null],
		['no season', { ...changes, season: undefined }],
		['no cursor', { ...changes, cursor: undefined }],
		['a numeric cursor', { ...changes, cursor: 5 }],
		['changed that is not a list', { ...changes, changed: {} }],
		['no top', { ...changes, top: undefined }],
	])('rejects a malformed answer: %s', async (_name, body) => {
		const fetch = createChangesClient(API, KEY, fakeFetch(200, body))
		await expect(fetch(changesRequest)).rejects.toThrow(
			'changes request failed: malformed answer',
		)
	})
})
