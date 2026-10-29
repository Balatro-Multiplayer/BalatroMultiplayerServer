// Telling a player who left a run early how it ended. A run whose result was
// pending settles after they are gone; the stored run already places them and
// rates them, so match history shows it. A player who is online also gets a
// notification, which the client prints in chat.
import { NotifyCode, notify } from '../notify'
import type { RatingResult, RunRecord } from './protocol'

export interface LateResult {
	runId: string
	code: string
	modId: string
	status: string
	place: number | null
	rating: RatingResult | null
}

export function lateResultContent(run: RunRecord, playerId: string): LateResult {
	const placement = run.placements.filter((p) => p.playerId === playerId)[0]
	return {
		runId: run.runId,
		code: run.code,
		modId: run.modId,
		status: run.status,
		place: placement ? placement.place : null,
		rating: (run.ratings && run.ratings[playerId]) || null,
	}
}

// Transient: an offline player sees the same result in their match history.
export function sendLateResults(nk: nkruntime.Nakama, run: RunRecord, playerIds: string[]) {
	for (const playerId of playerIds) {
		notify(nk, playerId, NotifyCode.RESULT_LATE, 'result_late', { ...lateResultContent(run, playerId) }, false)
	}
}
