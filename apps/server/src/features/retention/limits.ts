// Retention limits (Notice decisions 14-16): how long chat, evidence and ban
// records are kept. Pure rules; the hourly sweep (retention/sweep.ts) reads
// the facts and deletes what they say has passed its limit.
//
// Evidence is blocked or flagged chat and flagged or disputed runs (run logs
// in general: a report can point at any run). It is kept while a report or
// ban that uses it is open, then EVIDENCE_KEEP_MS. Evidence nothing uses is
// kept EVIDENCE_KEEP_MS from when it was made.

import type { EvidenceUse } from '../../contracts/IRetentionRepository.js'
import {
	type ItemStatus,
	isItemStatus,
} from '../service-queue/types.js'

const DAY_MS = 24 * 60 * 60 * 1000

export const CHAT_KEEP_MS = 90 * DAY_MS
export const EVIDENCE_KEEP_MS = 180 * DAY_MS
export const BAN_RECORD_KEEP_MONTHS = 12

// A report or ban that uses a piece of evidence: closedAt is null while it is
// open.
export interface EvidenceLink {
	closedAt: Date | null
}

export interface EvidenceRetention {
	madeAt: Date
	links: readonly EvidenceLink[]
}

export function evidencePurgeable(
	evidence: EvidenceRetention,
	now: Date,
): boolean {
	let keptFrom = evidence.madeAt.getTime()
	for (const link of evidence.links) {
		if (link.closedAt === null) return false
		keptFrom = Math.max(keptFrom, link.closedAt.getTime())
	}
	return now.getTime() - keptFrom > EVIDENCE_KEEP_MS
}

// A service queue item (a report, a flag) is open until it is resolved.
export function linkOfItem(item: {
	status: ItemStatus
	resolvedAt: Date | null
}): EvidenceLink {
	return { closedAt: item.status === 'open' ? null : item.resolvedAt }
}

// A ban is open while it is in force: closed when it ran out or was lifted.
export function linkOfBan(
	ban: { expiresAt: Date | null; liftedAt: Date | null },
	now: Date,
): EvidenceLink {
	const ends = [ban.liftedAt, ban.expiresAt].filter(
		(d): d is Date => d !== null && d <= now,
	)
	if (ends.length === 0) return { closedAt: null }
	return { closedAt: new Date(Math.min(...ends.map((d) => d.getTime()))) }
}

// The link a stored use stands for. A status this code does not know is
// kept, as an open item.
export function linkOf(use: EvidenceUse, now: Date): EvidenceLink {
	if (use.kind === 'ban') return linkOfBan(use, now)
	const status = isItemStatus(use.status) ? use.status : 'open'
	return linkOfItem({ status, resolvedAt: use.resolvedAt })
}

// evidencePurgeable, from the uses as stored.
export function storedEvidencePurgeable(
	evidence: { madeAt: Date; links: readonly EvidenceUse[] },
	now: Date,
): boolean {
	return evidencePurgeable(
		{ madeAt: evidence.madeAt, links: evidence.links.map((u) => linkOf(u, now)) },
		now,
	)
}

// A ban record is kept for the ban's length plus 12 months, so until 12 months
// after it was set to run out (lifting it early does not shorten that). A
// permanent ban's record is kept.
export function banRecordPurgeable(
	ban: { expiresAt: Date | null },
	now: Date,
): boolean {
	if (ban.expiresAt === null) return false
	return now > banRecordKeptUntil(ban.expiresAt)
}

export function banRecordKeptUntil(expiresAt: Date): Date {
	const until = new Date(expiresAt)
	until.setUTCMonth(until.getUTCMonth() + BAN_RECORD_KEEP_MONTHS)
	return until
}
