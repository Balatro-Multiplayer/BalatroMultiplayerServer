import {
	DISCORD_BOT_MAX_IDS,
	type DiscordBotStandingsAnswer,
	type DiscordBotStandingsRequest,
} from '@bmp/types'

// The API's POST /internal/discord-bot/standings (apps/server
// features/discord-bot). The API hashes the Discord ids with the salt used at
// link time and lists the top places in the public leaderboard's own order.
// The shapes are shared with the API through @bmp/types.

export const IDS_PER_REQUEST = DISCORD_BOT_MAX_IDS

export type StandingsAnswer = DiscordBotStandingsAnswer
export type StandingsRequest = DiscordBotStandingsRequest

export type FetchStandings = (req: StandingsRequest) => Promise<StandingsAnswer>

export function createStandingsClient(
	apiUrl: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): FetchStandings {
	return async (req) => {
		const res = await fetchImpl(`${apiUrl}/internal/discord-bot/standings`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-bmp-internal-key': apiKey,
			},
			body: JSON.stringify(req),
			signal: AbortSignal.timeout(30_000),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new Error(
				`standings request failed: HTTP ${res.status} ${text.slice(0, 200)}`,
			)
		}
		const body = (await res.json()) as StandingsAnswer
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
