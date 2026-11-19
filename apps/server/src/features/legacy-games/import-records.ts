// The legacy game logs import file: one JSON record per line, one per game.
// It carries the uploader's raw Discord id; `toInsert` swaps it for its salted
// hash, so no raw id reaches the database. Pure: the hash function is passed in.
import { gunzipSync } from 'node:zlib'
import type { LegacyGameResult } from '../../contracts/ILegacyGames.js'
import { type Result, err, ok } from '../../shared/utils/result.js'

export interface LegacyGameRecord {
	id: number
	ownerDiscordId: string | null
	ownerName: string | null
	opponentName: string | null
	startedAt: string
	endedAt: string | null
	timeExact: boolean
	result: LegacyGameResult | null
	deck: string | null
	stake: string | null
	seed: string | null
	beta: { season: number; matchKey: string } | null
	ownerEvents: string
	opponentEvents: string | null
}

export interface LegacyGameInsert {
	id: number
	discordIdHash: string | null
	ownerName: string | null
	opponentName: string | null
	startedAt: Date
	endedAt: Date | null
	timeExact: boolean
	result: LegacyGameResult | null
	deck: string | null
	stake: string | null
	seed: string | null
	betaSeason: number | null
	betaMatchKey: string | null
	ownerEvents: string
	opponentEvents: string | null
	sharedAt?: Date | null
}

const DISCORD_ID = /^\d{5,25}$/
const RESULTS: readonly (LegacyGameResult | null)[] = ['win', 'loss', null]

const textOrNull = (v: unknown, max: number): v is string | null =>
	v === null || (typeof v === 'string' && v.length <= max)
const dateText = (v: unknown): v is string =>
	typeof v === 'string' && !Number.isNaN(Date.parse(v))

// An events block must decode to a list of [t, opcode, args] tuples.
function isEventsBlock(v: unknown): v is string {
	if (typeof v !== 'string' || v.length === 0) return false
	try {
		const events = JSON.parse(
			gunzipSync(Buffer.from(v, 'base64')).toString('utf8'),
		)
		return (
			Array.isArray(events) &&
			events.every(
				(e) =>
					Array.isArray(e) &&
					typeof e[0] === 'number' &&
					typeof e[1] === 'string',
			)
		)
	} catch {
		return false
	}
}

export function parseLegacyGameRecord(
	line: string,
): Result<LegacyGameRecord, string> {
	let r: Record<string, unknown>
	try {
		r = JSON.parse(line)
	} catch {
		return err('JSON')
	}
	if (!r || typeof r !== 'object') return err('record')
	if (!Number.isInteger(r.id) || (r.id as number) < 1) return err('id')
	if (
		r.ownerDiscordId !== null &&
		!(typeof r.ownerDiscordId === 'string' && DISCORD_ID.test(r.ownerDiscordId))
	)
		return err('ownerDiscordId')
	if (!textOrNull(r.ownerName, 128)) return err('ownerName')
	if (!textOrNull(r.opponentName, 128)) return err('opponentName')
	if (!dateText(r.startedAt)) return err('startedAt')
	if (r.endedAt !== null && !dateText(r.endedAt)) return err('endedAt')
	if (typeof r.timeExact !== 'boolean') return err('timeExact')
	if (!RESULTS.includes(r.result as LegacyGameResult | null))
		return err('result')
	if (!textOrNull(r.deck, 64)) return err('deck')
	if (!textOrNull(r.stake, 64)) return err('stake')
	if (!textOrNull(r.seed, 32)) return err('seed')
	const beta = r.beta as Record<string, unknown> | null
	if (
		beta !== null &&
		!(
			beta &&
			typeof beta === 'object' &&
			Number.isInteger(beta.season) &&
			typeof beta.matchKey === 'string' &&
			beta.matchKey.length > 0 &&
			beta.matchKey.length <= 64
		)
	)
		return err('beta')
	if (!isEventsBlock(r.ownerEvents)) return err('ownerEvents')
	if (r.opponentEvents !== null && !isEventsBlock(r.opponentEvents))
		return err('opponentEvents')
	return ok(r as unknown as LegacyGameRecord)
}

export function toInsert(
	r: LegacyGameRecord,
	hash: (id: string) => string,
): LegacyGameInsert {
	return {
		id: r.id,
		discordIdHash: r.ownerDiscordId ? hash(r.ownerDiscordId) : null,
		ownerName: r.ownerName,
		opponentName: r.opponentName,
		startedAt: new Date(r.startedAt),
		endedAt: r.endedAt ? new Date(r.endedAt) : null,
		timeExact: r.timeExact,
		result: r.result,
		deck: r.deck,
		stake: r.stake,
		seed: r.seed,
		betaSeason: r.beta?.season ?? null,
		betaMatchKey: r.beta?.matchKey ?? null,
		ownerEvents: r.ownerEvents,
		opponentEvents: r.opponentEvents,
	}
}
