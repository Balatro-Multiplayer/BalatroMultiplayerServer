import {
	DISCORD_BOT_MAX_IDS,
	type DiscordBotChangesAnswer,
	type DiscordBotChangesRequest,
	type DiscordBotStandingsAnswer,
	type DiscordBotStandingsRequest,
} from '@bmp/types'

// The API's POST /internal/discord-bot/* (apps/server features/discord-bot).
// The API hashes the Discord ids with the salt used at link time and lists
// the top places in the public leaderboard's own order. The shapes are shared
// with the API through @bmp/types.

export const IDS_PER_REQUEST = DISCORD_BOT_MAX_IDS

export type StandingsAnswer = DiscordBotStandingsAnswer
export type StandingsRequest = DiscordBotStandingsRequest
export type ChangesAnswer = DiscordBotChangesAnswer
export type ChangesRequest = DiscordBotChangesRequest

export type FetchStandings = (req: StandingsRequest) => Promise<StandingsAnswer>
export type FetchChanges = (req: ChangesRequest) => Promise<ChangesAnswer>

function poster(apiUrl: string, apiKey: string, fetchImpl: typeof fetch) {
	return async (path: string, body: unknown): Promise<unknown> => {
		const res = await fetchImpl(`${apiUrl}/internal/discord-bot/${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-bmp-internal-key': apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new Error(
				`${path} request failed: HTTP ${res.status} ${text.slice(0, 200)}`,
			)
		}
		return res.json()
	}
}

export function createStandingsClient(
	apiUrl: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): FetchStandings {
	const post = poster(apiUrl, apiKey, fetchImpl)
	return async (req) => {
		const body = (await post('standings', req)) as StandingsAnswer
		if (
			typeof body?.season !== 'number' ||
			typeof body.players !== 'object' ||
			body.players === null ||
			!Array.isArray(body.top)
		)
			throw new Error('standings request failed: malformed answer')
		return body
	}
}

export function createChangesClient(
	apiUrl: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): FetchChanges {
	const post = poster(apiUrl, apiKey, fetchImpl)
	return async (req) => {
		const body = (await post('changes', req)) as ChangesAnswer
		if (
			typeof body?.season !== 'number' ||
			typeof body.cursor !== 'string' ||
			!Array.isArray(body.changed) ||
			!Array.isArray(body.top)
		)
			throw new Error('changes request failed: malformed answer')
		return body
	}
}
