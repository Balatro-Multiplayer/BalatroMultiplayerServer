// The retention sweep's reads and deletes (features/retention/sweep.ts).
// Each candidate comes with its links: the service queue items that use it
// (a report in its lobby or on its run, its flag, its anti-cheat item, its
// result conflict) and the bans those items issued. Which candidates go is
// decided by features/retention/limits.ts.
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type {
	BanRecordCandidate,
	EvidenceCandidate,
	IRetentionRepository,
} from '../../contracts/IRetentionRepository.js'
import {
	type EvidenceLink,
	linkOfBan,
	linkOfItem,
} from '../../features/retention/limits.js'
import { antiCheatSourceId } from '../../features/service-queue/source-ids.js'
import type { ItemType } from '../../features/service-queue/types.js'
import { db } from '../db/index.js'
import {
	chatLogs,
	flaggedMessages,
	lobbyRuns,
	matchResultConflicts,
	matchRunLogs,
	playerBans,
	reports,
	serviceQueueItemEvents,
	serviceQueueItems,
} from '../db/schema.js'

const EVIDENCE_DAYS = sql`interval '180 days'`
// Postgres takes at most 65535 parameters per query.
const CHUNK = 1000

function chunks<T>(items: T[]): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += CHUNK)
		out.push(items.slice(i, i + CHUNK))
	return out
}

interface ItemKey {
	itemType: ItemType
	sourceId: string
}

const keyOf = (k: ItemKey) => `${k.itemType}|${k.sourceId}`

// The links of each candidate, from the items each one is used by.
async function linksOf(
	itemsOf: Map<string, ItemKey[]>,
	now: Date,
): Promise<Map<string, EvidenceLink[]>> {
	const wanted = new Map<string, ItemKey>()
	for (const keys of itemsOf.values())
		for (const k of keys) wanted.set(keyOf(k), k)

	const linksOfItem = new Map<string, EvidenceLink[]>()
	const byType = new Map<ItemType, string[]>()
	for (const k of wanted.values())
		byType.set(k.itemType, [...(byType.get(k.itemType) ?? []), k.sourceId])
	const items: {
		id: number
		itemType: string
		sourceId: string
		status: string
		resolvedAt: Date | null
	}[] = []
	for (const [itemType, sourceIds] of byType)
		for (const part of chunks(sourceIds))
			items.push(
				...(await db
					.select({
						id: serviceQueueItems.id,
						itemType: serviceQueueItems.itemType,
						sourceId: serviceQueueItems.sourceId,
						status: serviceQueueItems.status,
						resolvedAt: serviceQueueItems.resolvedAt,
					})
					.from(serviceQueueItems)
					.where(
						and(
							eq(serviceQueueItems.itemType, itemType),
							inArray(serviceQueueItems.sourceId, part),
						),
					)),
			)

	// The bans an item's actions issued (dispatcher.ts records detail.banId).
	const bansOfItem = new Map<number, string[]>()
	for (const part of chunks(items.map((i) => i.id))) {
		const events = await db
			.select({
				itemId: serviceQueueItemEvents.itemId,
				banId: sql<string>`${serviceQueueItemEvents.detail}->>'banId'`,
			})
			.from(serviceQueueItemEvents)
			.where(
				and(
					inArray(serviceQueueItemEvents.itemId, part),
					isNotNull(sql`${serviceQueueItemEvents.detail}->>'banId'`),
				),
			)
		for (const e of events)
			bansOfItem.set(e.itemId, [...(bansOfItem.get(e.itemId) ?? []), e.banId])
	}
	const banIds = [...new Set([...bansOfItem.values()].flat())].filter((id) =>
		/^[0-9a-f-]{36}$/i.test(id),
	)
	const banLink = new Map<string, EvidenceLink>()
	for (const part of chunks(banIds)) {
		const bans = await db
			.select({
				id: playerBans.id,
				expiresAt: playerBans.expiresAt,
				liftedAt: playerBans.liftedAt,
			})
			.from(playerBans)
			.where(inArray(playerBans.id, part))
		for (const ban of bans) banLink.set(ban.id, linkOfBan(ban, now))
	}

	for (const item of items) {
		const links = [linkOfItem(item)]
		for (const banId of bansOfItem.get(item.id) ?? []) {
			const link = banLink.get(banId)
			if (link) links.push(link)
		}
		linksOfItem.set(`${item.itemType}|${item.sourceId}`, links)
	}

	const out = new Map<string, EvidenceLink[]>()
	for (const [candidate, keys] of itemsOf)
		out.set(
			candidate,
			keys.flatMap((k) => linksOfItem.get(keyOf(k)) ?? []),
		)
	return out
}

// Report ids per lobby instance.
async function reportsInLobbies(
	lobbyIds: string[],
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>()
	for (const part of chunks([...new Set(lobbyIds)])) {
		const rows = await db
			.select({ id: reports.id, lobbyId: reports.lobbyId })
			.from(reports)
			.where(inArray(reports.lobbyId, part))
		for (const r of rows)
			out.set(r.lobbyId, [...(out.get(r.lobbyId) ?? []), String(r.id)])
	}
	return out
}

interface FlaggedChatFacts {
	id: string
	madeAt: Date
	flaggedMessageId: number | null
	lobbyId: string | null
}

// A flagged chat line and its flagged_messages row are one piece of evidence:
// its flag item, and every report filed in its lobby, use both.
async function flaggedChatCandidates(
	rows: FlaggedChatFacts[],
	now: Date,
): Promise<EvidenceCandidate[]> {
	const lobbyReports = await reportsInLobbies(
		rows.flatMap((r) => (r.lobbyId ? [r.lobbyId] : [])),
	)
	const itemsOf = new Map<string, ItemKey[]>()
	for (const r of rows) {
		const keys: ItemKey[] = []
		if (r.flaggedMessageId !== null)
			keys.push({
				itemType: 'flagged_chat',
				sourceId: String(r.flaggedMessageId),
			})
		for (const reportId of (r.lobbyId && lobbyReports.get(r.lobbyId)) || [])
			keys.push({ itemType: 'report', sourceId: reportId })
		itemsOf.set(r.id, keys)
	}
	const links = await linksOf(itemsOf, now)
	return rows.map((r) => ({
		id: r.id,
		madeAt: r.madeAt,
		links: links.get(r.id) ?? [],
	}))
}

// The reports and bans that use each run: its anti-cheat items (one per
// player log), its result conflicts and the reports that name it.
async function runLinksOf(
	runIds: string[],
	now: Date,
): Promise<Map<string, EvidenceLink[]>> {
	const itemsOf = new Map<string, ItemKey[]>(runIds.map((id) => [id, []]))
	const add = (runId: string, key: ItemKey) => itemsOf.get(runId)?.push(key)
	for (const part of chunks(runIds)) {
		const logs = await db
			.select({ runId: matchRunLogs.runId, playerId: matchRunLogs.playerId })
			.from(matchRunLogs)
			.where(inArray(matchRunLogs.runId, part))
		for (const l of logs)
			add(l.runId, {
				itemType: 'anti_cheat',
				sourceId: antiCheatSourceId(l.runId, l.playerId),
			})
		const conflicts = await db
			.select({
				id: matchResultConflicts.id,
				runId: matchResultConflicts.matchId,
			})
			.from(matchResultConflicts)
			.where(inArray(matchResultConflicts.matchId, part))
		for (const c of conflicts)
			add(c.runId, { itemType: 'match_conflict', sourceId: String(c.id) })
		const runReports = await db
			.select({ id: reports.id, runId: reports.runId })
			.from(reports)
			.where(inArray(reports.runId, part))
		for (const r of runReports)
			if (r.runId)
				add(r.runId, { itemType: 'report', sourceId: String(r.id) })
	}
	return linksOf(itemsOf, now)
}

export const retentionRepository: IRetentionRepository = {
	async deleteExpiredChat(now) {
		const result = await db
			.delete(chatLogs)
			.where(and(eq(chatLogs.flagged, false), lt(chatLogs.expiresAt, now)))
		return result.rowCount ?? 0
	},

	async flaggedChatLineCandidates(now) {
		const rows = await db
			.select({
				id: chatLogs.id,
				madeAt: chatLogs.sentAt,
				flaggedMessageId: flaggedMessages.id,
				lobbyId: chatLogs.lobbyId,
			})
			.from(chatLogs)
			.leftJoin(
				flaggedMessages,
				eq(flaggedMessages.mirrorKey, chatLogs.mirrorKey),
			)
			.where(
				and(
					eq(chatLogs.flagged, true),
					sql`coalesce(${chatLogs.expiresAt}, ${chatLogs.sentAt} + ${EVIDENCE_DAYS}) < ${now}`,
				),
			)
		return flaggedChatCandidates(
			rows.map((r) => ({ ...r, id: String(r.id) })),
			now,
		)
	},

	async deleteFlaggedChatLines(ids) {
		let deleted = 0
		for (const part of chunks(ids.map(Number))) {
			const result = await db
				.delete(chatLogs)
				.where(and(eq(chatLogs.flagged, true), inArray(chatLogs.id, part)))
			deleted += result.rowCount ?? 0
		}
		return deleted
	},

	async flaggedMessageCandidates(now) {
		const rows = await db
			.select({
				id: flaggedMessages.id,
				madeAt: flaggedMessages.flaggedAt,
				lobbyId: chatLogs.lobbyId,
			})
			.from(flaggedMessages)
			.leftJoin(chatLogs, eq(chatLogs.mirrorKey, flaggedMessages.mirrorKey))
			.where(lt(flaggedMessages.expiresAt, now))
		return flaggedChatCandidates(
			rows.map((r) => ({ ...r, id: String(r.id), flaggedMessageId: r.id })),
			now,
		)
	},

	async deleteFlaggedMessages(ids) {
		let deleted = 0
		for (const part of chunks(ids.map(Number))) {
			const result = await db
				.delete(flaggedMessages)
				.where(inArray(flaggedMessages.id, part))
			deleted += result.rowCount ?? 0
		}
		return deleted
	},

	// A run is one piece of evidence: its anti-cheat items, its result
	// conflicts and the reports filed on it use every log it has.
	async runCandidates(now) {
		const madeAt = sql<Date>`coalesce(${matchRunLogs.finalizedAt}, ${lobbyRuns.startedAt})`
		const runs = await db
			.select({
				runId: matchRunLogs.runId,
				madeAt: sql`max(${madeAt})`.mapWith(lobbyRuns.startedAt),
			})
			.from(matchRunLogs)
			.innerJoin(lobbyRuns, eq(lobbyRuns.id, matchRunLogs.runId))
			.groupBy(matchRunLogs.runId)
			.having(
				sql`max(coalesce(${matchRunLogs.expiresAt}, ${madeAt} + ${EVIDENCE_DAYS})) < ${now}`,
			)
		if (runs.length === 0) return []

		const links = await runLinksOf(
			runs.map((r) => r.runId),
			now,
		)
		return runs.map((r) => ({
			id: r.runId,
			madeAt: r.madeAt,
			links: links.get(r.runId) ?? [],
		}))
	},

	runLinks: runLinksOf,

	async deleteRunLogs(runIds) {
		let deleted = 0
		for (const part of chunks(runIds)) {
			const result = await db
				.delete(matchRunLogs)
				.where(inArray(matchRunLogs.runId, part))
			deleted += result.rowCount ?? 0
		}
		return deleted
	},

	async banRecordCandidates(now): Promise<BanRecordCandidate[]> {
		return db
			.select({ id: playerBans.id, expiresAt: playerBans.expiresAt })
			.from(playerBans)
			.where(sql`${playerBans.expiresAt} + interval '12 months' < ${now}`)
	},

	async deleteBanRecords(ids) {
		let deleted = 0
		for (const part of chunks(ids)) {
			const result = await db
				.delete(playerBans)
				.where(inArray(playerBans.id, part))
			deleted += result.rowCount ?? 0
		}
		return deleted
	},
}
