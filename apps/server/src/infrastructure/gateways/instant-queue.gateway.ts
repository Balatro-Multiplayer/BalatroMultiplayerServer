import { BOARD_NAMES, type BoardMods, boardName } from '@bmp/types'
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import {
	EMPTY_RANGE,
	type InstantRange,
	isActive,
	rangeKey,
} from '../../features/instant-queue/ranges.js'
import type { DbExecutor } from '../db/executor.js'
import { db } from '../db/index.js'
import {
	instantQueueRanges,
	matchmakingRatings,
	seasons,
} from '../db/schema.js'

// The season Nakama rates into: the active one, else the latest.
async function ratingSeason(exec: DbExecutor): Promise<number | undefined> {
	const [active] = await exec
		.select({ id: seasons.id })
		.from(seasons)
		.where(isNull(seasons.endedAt))
		.limit(1)
	if (active) return active.id
	const [latest] = await exec
		.select({ id: seasons.id })
		.from(seasons)
		.orderBy(desc(seasons.id))
		.limit(1)
	return latest?.id
}

function rangeOf(row: {
	enabled: boolean
	floor: number | null
	ceiling: number | null
	floorMultiplier: number
	ceilingMultiplier: number
}): InstantRange {
	return {
		enabled: row.enabled,
		floor: row.floor,
		ceiling: row.ceiling,
		floorMultiplier: row.floorMultiplier,
		ceilingMultiplier: row.ceilingMultiplier,
	}
}

// Every range Nakama and the mod act on (on, with an edge), keyed as Nakama's config keys them.
export async function loadInstantRanges(
	exec: DbExecutor = db,
): Promise<Record<string, InstantRange>> {
	const rows = await exec.select().from(instantQueueRanges)
	const out: Record<string, InstantRange> = {}
	for (const row of rows) {
		const range = rangeOf(row)
		if (isActive(range)) out[rangeKey(row.modId, row.gameMode)] = range
	}
	return out
}

export interface InstantQueueRow {
	modId: string
	gameMode: string
	// "PvP Expanded"; the raw key for a queue with no display name.
	label: string
	range: InstantRange
	// Players rated in the queue this season.
	rated: number
}

// The queues staff can set a range on: every ranked board, and any other queue
// with a rating this season or a row, with its range. Boards first, in the
// order the Leaderboards page lists them.
const labelOf = (modId: string, gameMode: string): string =>
	boardName(modId, gameMode) ?? `${modId} ${gameMode}`

export async function listInstantQueues(
	exec: DbExecutor = db,
): Promise<InstantQueueRow[]> {
	const season = await ratingSeason(exec)
	const rated =
		season === undefined
			? []
			: await exec
					.select({
						modId: matchmakingRatings.modId,
						gameMode: matchmakingRatings.gameMode,
						n: sql<number>`count(*)::int`,
					})
					.from(matchmakingRatings)
					.where(eq(matchmakingRatings.season, season))
					.groupBy(matchmakingRatings.modId, matchmakingRatings.gameMode)
					.orderBy(
						asc(matchmakingRatings.modId),
						asc(matchmakingRatings.gameMode),
					)
	const stored = await exec.select().from(instantQueueRanges)
	const rows = new Map<string, InstantQueueRow>()
	const row = (modId: string, gameMode: string): InstantQueueRow => {
		const key = rangeKey(modId, gameMode)
		let r = rows.get(key)
		if (!r) {
			r = {
				modId,
				gameMode,
				label: labelOf(modId, gameMode),
				range: { ...EMPTY_RANGE },
				rated: 0,
			}
			rows.set(key, r)
		}
		return r
	}
	for (const [modId, mod] of Object.entries(BOARD_NAMES as BoardMods))
		for (const gameMode of Object.keys(mod.modes)) row(modId, gameMode)
	for (const r of rated) row(r.modId, r.gameMode).rated = r.n
	for (const s of stored) row(s.modId, s.gameMode).range = rangeOf(s)
	return [...rows.values()]
}

export interface RangeCounts {
	// Players rated at or above the floor / at or below the ceiling this
	// season; null for an edge that is not set.
	floor: number | null
	ceiling: number | null
}

// How many players each edge takes in, from this season's stored ratings (the
// decay a player's rating takes while idle is not applied).
export async function countInRange(
	modId: string,
	gameMode: string,
	floor: number | null,
	ceiling: number | null,
	exec: DbExecutor = db,
): Promise<RangeCounts> {
	const season = await ratingSeason(exec)
	const count = async (edge: ReturnType<typeof gte>): Promise<number> => {
		if (season === undefined) return 0
		const [row] = await exec
			.select({ n: sql<number>`count(*)::int` })
			.from(matchmakingRatings)
			.where(
				and(
					eq(matchmakingRatings.modId, modId),
					eq(matchmakingRatings.gameMode, gameMode),
					eq(matchmakingRatings.season, season),
					edge,
				),
			)
		return row?.n ?? 0
	}
	return {
		floor:
			floor === null
				? null
				: await count(gte(matchmakingRatings.rating, floor)),
		ceiling:
			ceiling === null
				? null
				: await count(lte(matchmakingRatings.rating, ceiling)),
	}
}

export async function setInstantRange(
	exec: DbExecutor,
	modId: string,
	gameMode: string,
	range: InstantRange,
): Promise<void> {
	await exec
		.insert(instantQueueRanges)
		.values({ modId, gameMode, ...range })
		.onConflictDoUpdate({
			target: [instantQueueRanges.modId, instantQueueRanges.gameMode],
			set: { ...range, updatedAt: new Date() },
		})
}

export async function getInstantRange(
	modId: string,
	gameMode: string,
	exec: DbExecutor = db,
): Promise<InstantRange> {
	const [row] = await exec
		.select()
		.from(instantQueueRanges)
		.where(
			and(
				eq(instantQueueRanges.modId, modId),
				eq(instantQueueRanges.gameMode, gameMode),
			),
		)
		.limit(1)
	return row ? rangeOf(row) : { ...EMPTY_RANGE }
}
