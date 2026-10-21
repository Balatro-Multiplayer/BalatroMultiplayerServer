// Who a warn, mute or ban can be aimed at: a report's reported player (the
// subject) or its reporter (a false report); either reporter of a conflict;
// otherwise the item's subject.
import type { TargetRole } from './types.js'

export interface Target {
	role: TargetRole
	playerId: string
}

export interface TargetSources {
	subjectPlayerId: string | null
	report?: { reporterId: string; reportedId: string } | null
	conflict?: { firstReporterId: string; conflictingReporterId: string } | null
}

export function targetsOf(item: { itemType: string } & TargetSources): Target[] {
	if (item.itemType === 'report' && item.report)
		return [
			{ role: 'subject', playerId: item.report.reportedId },
			{ role: 'reporter', playerId: item.report.reporterId },
		]
	if (item.itemType === 'match_conflict' && item.conflict)
		return [
			{ role: 'first_reporter', playerId: item.conflict.firstReporterId },
			{ role: 'conflicting_reporter', playerId: item.conflict.conflictingReporterId },
		]
	return item.subjectPlayerId ? [{ role: 'subject', playerId: item.subjectPlayerId }] : []
}

export type TargetPick = { ok: true; target: Target } | { ok: false; refusal: 'no_subject' | 'invalid_target' }

// The requested target, or the subject when none was named.
export function pickTarget(targets: readonly Target[], requested: string | null): TargetPick {
	if (requested === null) {
		const subject = targets.find((t) => t.role === 'subject')
		return subject ? { ok: true, target: subject } : { ok: false, refusal: 'no_subject' }
	}
	const target = targets.find((t) => t.playerId === requested)
	return target ? { ok: true, target } : { ok: false, refusal: 'invalid_target' }
}
