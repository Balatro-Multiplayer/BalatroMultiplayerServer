// Who a finished run's result is suspect for: a replay log that fails its
// hash check, or more scored hands than the game's real length allows (the
// API's evaluateAntiCheat, with MIN_MS_PER_HAND from anti-cheat.config.ts).
// A flagged player isn't rated, and the run goes to the moderators' service
// queue through the mirror. Pure.
import type { FlagReason, LogCheck, PlayerLog, RunRecord } from './protocol'

// The least time (ms) one hand can take to select and score.
export const MIN_MS_PER_HAND = 3000

// The replay opcode for a scored hand (PvP's pvp_api/net.lua).
const HAND_OPCODE = 'hand_result'

export function handCount(log: PlayerLog | undefined): number {
	if (!log) return 0
	let hands = 0
	for (const line of log.lines) if ((JSON.parse(line) as unknown[])[1] === HAND_OPCODE) hands++
	return hands
}

export function runFlags(
	run: RunRecord,
	logs: { [userId: string]: PlayerLog },
	checks: { [userId: string]: LogCheck },
): { [userId: string]: FlagReason } {
	const flags: { [userId: string]: FlagReason } = {}
	const elapsedMs = run.endedAt - run.startedAt
	for (const player of run.players) {
		if (checks[player.id] === 'mismatch') flags[player.id] = 'hash_mismatch'
		else if (handCount(logs[player.id]) * MIN_MS_PER_HAND > elapsedMs) flags[player.id] = 'elapsed_time_gate'
	}
	return flags
}
