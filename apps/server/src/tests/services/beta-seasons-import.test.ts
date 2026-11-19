import { describe, expect, it } from 'vitest'
import {
	parseBetaRecord,
	toRow,
} from '../../features/beta-seasons/import-records.js'

const standing = {
	kind: 'standing',
	season: 3,
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_expanded',
	discordId: '123456789012345678',
	name: 'Old Name',
	rank: 1,
	rating: 1292.4,
	peakRating: 1305,
	wins: 394,
	losses: 199,
	gamesPlayed: 593,
}

const game = {
	kind: 'game',
	season: 5,
	modId: 'MultiplayerPvP',
	gameMode: 'ranked:pvp_ranked_smallworld',
	matchKey: 'botlatro:56401',
	discordId: '123456789012345678',
	playedAt: '2025-12-02T10:00:00.000Z',
	opponentDiscordId: '876543210987654321',
	opponentName: 'Rival',
	result: 'win',
	ratingAfter: 316.4,
	ratingChange: 27.5,
	deck: 'Magic Deck',
	stake: 'White Stake',
}

const fakeHash = (id: string) => `hash(${id})`

describe('Beta Seasons import records', () => {
	it('reads a season, a standing and a game', () => {
		const season = parseBetaRecord(
			JSON.stringify({
				kind: 'season',
				number: 1,
				name: 'Beta Season 1',
				startedAt: null,
				endedAt: '2025-04-02T19:00:00.000Z',
			}),
		)
		expect(season.ok).toBe(true)
		expect(parseBetaRecord(JSON.stringify(standing)).ok).toBe(true)
		expect(parseBetaRecord(JSON.stringify(game)).ok).toBe(true)
	})

	it('names the first bad field', () => {
		const bad = (r: object) => {
			const parsed = parseBetaRecord(JSON.stringify(r))
			return parsed.ok ? null : parsed.error
		}
		expect(bad({ ...standing, discordId: 'not-an-id' })).toBe('discordId')
		expect(bad({ ...standing, rank: 0 })).toBe('rank')
		expect(bad({ ...game, result: 'draw' })).toBe('result')
		expect(bad({ ...game, playedAt: 'yesterday' })).toBe('playedAt')
		expect(bad({ ...standing, kind: 'player' })).toBe('kind')
		expect(parseBetaRecord('{oops').ok).toBe(false)
	})

	it('takes only boards the website knows, under the ranked: key', () => {
		const bad = (gameMode: string, modId = 'MultiplayerPvP') => {
			const parsed = parseBetaRecord(
				JSON.stringify({ ...standing, modId, gameMode }),
			)
			return parsed.ok ? null : parsed.error
		}
		expect(bad('pvp_ranked_expanded')).toBe('modId/gameMode')
		expect(bad('ranked:pvp_casual')).toBe('modId/gameMode')
		expect(bad('ranked:pvp_ranked_expanded', 'SomeOtherMod')).toBe(
			'modId/gameMode',
		)
		expect(bad('ranked:pvp_ranked_balanced')).toBeNull()
	})

	it('stores hashes in place of every Discord id', () => {
		const parsedStanding = parseBetaRecord(JSON.stringify(standing))
		const parsedGame = parseBetaRecord(JSON.stringify(game))
		if (!parsedStanding.ok || !parsedGame.ok) throw new Error('should parse')

		const s = toRow(parsedStanding.value, fakeHash)
		const g = toRow(parsedGame.value, fakeHash)
		expect(s).toMatchObject({
			table: 'standing',
			row: { discordIdHash: 'hash(123456789012345678)', name: 'Old Name' },
		})
		expect(g).toMatchObject({
			table: 'game',
			row: {
				discordIdHash: 'hash(123456789012345678)',
				opponentIdHash: 'hash(876543210987654321)',
				playedAt: new Date('2025-12-02T10:00:00.000Z'),
			},
		})
		const text = JSON.stringify([s, g])
		expect(text).not.toContain('"123456789012345678"')
		expect(text).not.toContain('"876543210987654321"')
	})

	it('keeps a game with no known opponent', () => {
		const parsed = parseBetaRecord(
			JSON.stringify({ ...game, opponentDiscordId: null, opponentName: null }),
		)
		if (!parsed.ok) throw new Error('should parse')
		expect(toRow(parsed.value, fakeHash)).toMatchObject({
			row: { opponentIdHash: null, opponentName: null },
		})
	})
})
