// The Beta Seasons import file: one JSON record per line. It carries raw
// Discord ids; `toRows` swaps each for its salted hash, so no raw id reaches
// the database. Pure: the hash function is passed in.
import { BOARD_NAMES, type BoardMods } from '@bmp/types'
import type { BetaGameResult } from '../../contracts/IBetaSeasons.js'
import { type Result, err, ok } from '../../shared/utils/result.js'

export interface SeasonRecord {
	kind: 'season'
	number: number
	name: string
	startedAt: string | null
	endedAt: string | null
}

export interface StandingRecord {
	kind: 'standing'
	season: number
	modId: string
	gameMode: string
	discordId: string
	name: string
	rank: number
	rating: number
	peakRating: number | null
	wins: number
	losses: number
	gamesPlayed: number
}

export interface GameRecord {
	kind: 'game'
	season: number
	modId: string
	gameMode: string
	matchKey: string
	discordId: string
	playedAt: string
	opponentDiscordId: string | null
	opponentName: string | null
	result: BetaGameResult
	ratingAfter: number | null
	ratingChange: number | null
	deck: string | null
	stake: string | null
}

export type BetaRecord = SeasonRecord | StandingRecord | GameRecord

const RESULTS: readonly BetaGameResult[] = ['win', 'loss', 'tie']
const DISCORD_ID = /^\d{5,25}$/

type Fields = Record<string, unknown>

function isInt(v: unknown): v is number {
	return Number.isInteger(v)
}
function isNum(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v)
}
function isNumOrNull(v: unknown): v is number | null {
	return v === null || isNum(v)
}
function isText(v: unknown, max: number): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= max
}
function isTextOrNull(v: unknown, max: number): v is string | null {
	return v === null || (typeof v === 'string' && v.length <= max)
}
function isDateText(v: unknown): v is string {
	return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}
function isDateOrNull(v: unknown): v is string | null {
	return v === null || isDateText(v)
}

// A board must be one the website knows, under its `ranked:` key.
function isKnownBoard(modId: unknown, gameMode: unknown): boolean {
	if (typeof modId !== 'string' || typeof gameMode !== 'string') return false
	const mod = (BOARD_NAMES as BoardMods)[modId]
	if (!mod || !gameMode.startsWith('ranked:')) return false
	return gameMode.slice('ranked:'.length) in mod.modes
}

function checkSeason(f: Fields): string | null {
	if (!isInt(f.number) || f.number < 1) return 'number'
	if (!isText(f.name, 64)) return 'name'
	if (!isDateOrNull(f.startedAt)) return 'startedAt'
	if (!isDateOrNull(f.endedAt)) return 'endedAt'
	return null
}

function checkStanding(f: Fields): string | null {
	if (!isInt(f.season) || f.season < 1) return 'season'
	if (!isKnownBoard(f.modId, f.gameMode)) return 'modId/gameMode'
	if (typeof f.discordId !== 'string' || !DISCORD_ID.test(f.discordId))
		return 'discordId'
	if (!isText(f.name, 128)) return 'name'
	if (!isInt(f.rank) || f.rank < 1) return 'rank'
	if (!isNum(f.rating)) return 'rating'
	if (!isNumOrNull(f.peakRating)) return 'peakRating'
	for (const k of ['wins', 'losses', 'gamesPlayed'] as const)
		if (!isInt(f[k]) || (f[k] as number) < 0) return k
	return null
}

function checkGame(f: Fields): string | null {
	if (!isInt(f.season) || f.season < 1) return 'season'
	if (!isKnownBoard(f.modId, f.gameMode)) return 'modId/gameMode'
	if (!isText(f.matchKey, 64)) return 'matchKey'
	if (typeof f.discordId !== 'string' || !DISCORD_ID.test(f.discordId))
		return 'discordId'
	if (!isDateText(f.playedAt)) return 'playedAt'
	if (
		f.opponentDiscordId !== null &&
		(typeof f.opponentDiscordId !== 'string' ||
			!DISCORD_ID.test(f.opponentDiscordId))
	)
		return 'opponentDiscordId'
	if (!isTextOrNull(f.opponentName, 128)) return 'opponentName'
	if (!RESULTS.includes(f.result as BetaGameResult)) return 'result'
	if (!isNumOrNull(f.ratingAfter)) return 'ratingAfter'
	if (!isNumOrNull(f.ratingChange)) return 'ratingChange'
	if (!isTextOrNull(f.deck, 64)) return 'deck'
	if (!isTextOrNull(f.stake, 64)) return 'stake'
	return null
}

/** One line of the file, checked. The error names the first bad field. */
export function parseBetaRecord(line: string): Result<BetaRecord, string> {
	let f: Fields
	try {
		f = JSON.parse(line) as Fields
	} catch {
		return err('not JSON')
	}
	if (typeof f !== 'object' || f === null) return err('not an object')
	const check =
		f.kind === 'season'
			? checkSeason
			: f.kind === 'standing'
				? checkStanding
				: f.kind === 'game'
					? checkGame
					: null
	if (!check) return err('kind')
	const bad = check(f)
	return bad ? err(bad) : ok(f as unknown as BetaRecord)
}

export interface SeasonRow {
	number: number
	name: string
	startedAt: Date | null
	endedAt: Date | null
}

export interface StandingRow {
	season: number
	modId: string
	gameMode: string
	discordIdHash: string
	name: string
	rank: number
	rating: number
	peakRating: number | null
	wins: number
	losses: number
	gamesPlayed: number
}

export interface GameRow {
	season: number
	modId: string
	gameMode: string
	matchKey: string
	discordIdHash: string
	playedAt: Date
	opponentIdHash: string | null
	opponentName: string | null
	result: BetaGameResult
	ratingAfter: number | null
	ratingChange: number | null
	deck: string | null
	stake: string | null
}

export type BetaRow =
	| { table: 'season'; row: SeasonRow }
	| { table: 'standing'; row: StandingRow }
	| { table: 'game'; row: GameRow }

const dateOrNull = (v: string | null) => (v === null ? null : new Date(v))

/** The database row for a record, with every Discord id swapped for its hash. */
export function toRow(r: BetaRecord, hash: (id: string) => string): BetaRow {
	switch (r.kind) {
		case 'season':
			return {
				table: 'season',
				row: {
					number: r.number,
					name: r.name,
					startedAt: dateOrNull(r.startedAt),
					endedAt: dateOrNull(r.endedAt),
				},
			}
		case 'standing':
			return {
				table: 'standing',
				row: {
					season: r.season,
					modId: r.modId,
					gameMode: r.gameMode,
					discordIdHash: hash(r.discordId),
					name: r.name,
					rank: r.rank,
					rating: r.rating,
					peakRating: r.peakRating,
					wins: r.wins,
					losses: r.losses,
					gamesPlayed: r.gamesPlayed,
				},
			}
		case 'game':
			return {
				table: 'game',
				row: {
					season: r.season,
					modId: r.modId,
					gameMode: r.gameMode,
					matchKey: r.matchKey,
					discordIdHash: hash(r.discordId),
					playedAt: new Date(r.playedAt),
					opponentIdHash:
						r.opponentDiscordId === null ? null : hash(r.opponentDiscordId),
					opponentName: r.opponentName,
					result: r.result,
					ratingAfter: r.ratingAfter,
					ratingChange: r.ratingChange,
					deck: r.deck,
					stake: r.stake,
				},
			}
	}
}
