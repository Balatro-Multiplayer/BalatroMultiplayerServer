// Turns a recorded launcher-integrity failure into an integrity item when
// integrity-flag.ts says it should be one. Called after the failure's event
// row is written (features/nakama/integrity.ts), so today's count includes it.
import type { LauncherIntegrityFailureReason } from '../../shared/types/index.js'
import { decideIntegrityFlag, integritySourceId, utcDayStart } from './integrity-flag.js'
import type { ItemContext } from './types.js'

export interface IntegrityIntakeDeps {
	// Whether the player is ranked-queued or in a ranked game; null when Nakama
	// could not be asked (then only the daily count decides).
	rankedContext(nakamaUserId: string): Promise<{ queued: boolean; inGame: boolean } | null>
	countFailuresSince(playerId: string, since: Date): Promise<number>
	enqueue(input: {
		itemType: 'integrity'
		sourceId: string
		subjectPlayerId: string
		summary: string
		context: ItemContext
	}): Promise<unknown>
	now(): Date
}

export function createIntegrityIntake(deps: IntegrityIntakeDeps) {
	return {
		async noteFailure(playerId: string, nakamaUserId: string, reason: LauncherIntegrityFailureReason): Promise<void> {
			const now = deps.now()
			const [ranked, failuresToday] = await Promise.all([
				deps.rankedContext(nakamaUserId),
				deps.countFailuresSince(playerId, utcDayStart(now)),
			])
			const decision = decideIntegrityFlag({ ranked, failuresToday })
			if (decision.kind === 'none') return
			await deps.enqueue({
				itemType: 'integrity',
				sourceId: integritySourceId(playerId, now),
				subjectPlayerId: playerId,
				summary:
					decision.trigger === 'ranked'
						? `Launcher integrity ${reason} during ranked play`
						: `Launcher integrity failures — ${failuresToday} today (latest: ${reason})`,
				context: { lobbyKind: decision.trigger === 'ranked' ? 'ranked' : 'none', integrityTrigger: decision.trigger },
			})
		},
	}
}

export type IntegrityIntake = ReturnType<typeof createIntegrityIntake>
