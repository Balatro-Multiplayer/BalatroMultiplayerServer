// A player's fastest completed Speedrun run, from their log: each Balatro run
// starts with run_info and a completed one ends with run_complete (both
// stamped with ms since the match began). t is client-written, so a run only
// counts when it is plausible: it can't outlast the game as the server timed
// it, and reaching ante 9 takes at least eight scored hands (one per boss
// blind), each taking at least minMsPerHand. Pure.
import type { LogEvent } from '../../shared/replay/events'

const LEAST_HANDS_TO_WIN = 8

export function fastestRunMs(events: LogEvent[], serverElapsedMs: number, minMsPerHand: number): number | null {
	let fastest: number | null = null
	let runStart: number | null = null
	let plays = 0
	for (const event of events) {
		if (event.opcode === 'run_info') {
			runStart = event.t
			plays = 0
		} else if (event.opcode === 'play') {
			plays++
		} else if (event.opcode === 'run_complete' && runStart !== null) {
			const ms = event.t - runStart
			const plausible = plays >= LEAST_HANDS_TO_WIN && ms >= plays * minMsPerHand && ms <= serverElapsedMs
			if (plausible && (fastest === null || ms < fastest)) fastest = ms
			runStart = null
		}
	}
	return fastest
}
