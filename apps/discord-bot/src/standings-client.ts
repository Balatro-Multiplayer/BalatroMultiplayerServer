import type { MemberStanding } from './rank-logic.js'

// The API's POST /internal/discord-bot/standings (apps/server
// features/discord-bot). The API hashes the Discord ids with the salt used at
// link time and ranks with the public leaderboard's own query.

export const IDS_PER_REQUEST = 1000

export interface LinkedStanding extends MemberStanding {
	playerId: string
}

export interface StandingsAnswer {
	season: number
	previousSeason: number | null
	/** Keyed by Discord id. A missing id has no linked player. */
	players: Record<string, LinkedStanding>
	/** The first `topN` places, in order. */
	top: { playerId: string; rank: number }[]
}

export interface StandingsRequest {
	modId: string
	gameMode: string
	topN: number
	discordIds: string[]
}

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
