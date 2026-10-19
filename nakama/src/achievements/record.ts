// Counts finished games and one-off milestones toward each player's avatar
// achievements, and tells a player which avatars they just earned
// (AVATAR_UNLOCKED, persistent). Does nothing while achievementsEnabled is
// off. lobby/match.ts calls recordRun once a run is stored; a failure for
// one player never stops the others.
import { readConfig } from '../config'
import { MIN_MS_PER_HAND } from '../lobby/anticheat'
import type { RunRecord } from '../lobby/protocol'
import { notify, NotifyCode } from '../notify'
import { profileFor } from '../player/profile'
import type { AvatarId } from '../shared/avatars/ids'
import type { Milestone } from '../shared/avatars/rules'
import type { LogEvent } from '../shared/replay/events'
import { eligibilityOf, type Eligibility } from './eligibility'
import { logFactsOf, type LogFacts } from './facts'
import { applyGame, utcDayOf, withMilestone, withUnlocked, type Progress } from './progress'
import { updateProgress } from './storage'
import { newlyUnlocked } from './unlocks'

// The participant avatar that is the metShowman milestone for the others.
const SHOWMAN: AvatarId = 'j_ring_master'

export interface RunOutcome {
	progress: Progress
	eligibility: Eligibility
	unlocked: AvatarId[]
}

export function factsByPlayer(run: RunRecord, events: { [userId: string]: LogEvent[] }): { [userId: string]: LogFacts } {
	const context = {
		serverElapsedMs: run.endedAt - run.startedAt,
		serverGamemode: (run.options as { gamemode?: unknown } | null)?.gamemode ?? null,
		minMsPerHand: MIN_MS_PER_HAND,
	}
	const facts: { [userId: string]: LogFacts } = {}
	for (const player of run.players) facts[player.id] = logFactsOf(events[player.id] || [], context)
	return facts
}

export function metShowman(run: RunRecord, playerId: string): boolean {
	return run.players.some((p) => p.id !== playerId && p.avatar === SHOWMAN)
}

// Earns whatever progress now meets.
export function withEarned(progress: Progress, privileges: readonly string[]): { progress: Progress; unlocked: AvatarId[] } {
	const unlocked = newlyUnlocked(progress, privileges)
	return { progress: withUnlocked(progress, unlocked), unlocked }
}

// Pure: progress after one player's part in a run.
export function outcomeOf(
	progress: Progress,
	run: RunRecord,
	playerId: string,
	facts: { [userId: string]: LogFacts },
	privileges: readonly string[],
): RunOutcome {
	const eligibility = eligibilityOf(run, playerId, facts, metShowman(run, playerId), progress, utcDayOf(run.endedAt))
	if (eligibility.kind === 'skipped') return { progress, eligibility, unlocked: [] }
	const earned = withEarned(applyGame(progress, eligibility.game), privileges)
	return { progress: earned.progress, eligibility, unlocked: earned.unlocked }
}

function announce(nk: nkruntime.Nakama, userId: string, avatarIds: AvatarId[], runId: string | null) {
	if (avatarIds.length === 0) return
	notify(nk, userId, NotifyCode.AVATAR_UNLOCKED, 'avatar_unlocked', { avatarIds, runId }, true)
}

export function recordRun(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	run: RunRecord,
	events: { [userId: string]: LogEvent[] },
) {
	if (!readConfig(nk).achievementsEnabled) return
	const facts = factsByPlayer(run, events)
	for (const player of run.players) {
		try {
			const privileges = profileFor(nk, player.id).privileges
			let outcome: RunOutcome | null = null
			updateProgress(nk, player.id, (progress) => {
				outcome = outcomeOf(progress, run, player.id, facts, privileges)
				return outcome.progress
			})
			const result = outcome as RunOutcome | null
			if (!result) continue
			if (result.eligibility.kind === 'skipped')
				logger.debug('Run %s: not counted for %s (%s)', run.runId, player.id, result.eligibility.reason)
			announce(nk, player.id, result.unlocked, run.runId)
		} catch (e) {
			logger.error('Run %s: could not record achievements for %s: %v', run.runId, player.id, e)
		}
	}
}

// Records a milestone reached outside a game (linking Discord), earning
// what it unlocks. Does nothing while achievements are off.
export function recordMilestone(
	nk: nkruntime.Nakama,
	logger: nkruntime.Logger,
	userId: string,
	milestone: Milestone,
	privileges: readonly string[],
) {
	if (!readConfig(nk).achievementsEnabled) return
	try {
		let unlocked: AvatarId[] = []
		updateProgress(nk, userId, (progress) => {
			const marked = withMilestone(progress, milestone)
			if (marked === progress) {
				unlocked = []
				return progress
			}
			const earned = withEarned(marked, privileges)
			unlocked = earned.unlocked
			return earned.progress
		})
		announce(nk, userId, unlocked, null)
	} catch (e) {
		logger.error('Could not record milestone %s for %s: %v', milestone, userId, e)
	}
}
