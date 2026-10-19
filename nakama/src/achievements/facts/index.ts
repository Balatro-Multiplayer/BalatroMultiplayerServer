// Everything achievements read from one player's replay log of one game.
// Pure: the log's events in, plain numbers out.
import type { LogEvent } from '../../shared/replay/events'
import { countOf, livesLost, suitChangersUsed } from './actions'
import { moneySpent } from './money'
import { bestHandScore } from './score'
import { gameSetupOf, type GameSetup } from './setup'
import { fastestRunMs } from './speedrun'

export interface LogFacts {
	hands: number
	rerolls: number
	skips: number
	moneySpent: number
	suitChangers: number
	livesLost: number
	// May be Infinity (a score past a double).
	bestHandScore: number
	setup: GameSetup
	fastestSpdrnRunMs: number | null
}

export interface LogContext {
	// endedAt - startedAt of the run, as the server timed it.
	serverElapsedMs: number
	// The run record's options.gamemode.
	serverGamemode: unknown
	minMsPerHand: number
}

export function logFactsOf(events: LogEvent[], context: LogContext): LogFacts {
	return {
		hands: countOf(events, 'play'),
		rerolls: countOf(events, 'reroll'),
		skips: countOf(events, 'skip_blind'),
		moneySpent: moneySpent(events),
		suitChangers: suitChangersUsed(events),
		livesLost: livesLost(events),
		bestHandScore: bestHandScore(events),
		setup: gameSetupOf(events, context.serverGamemode),
		fastestSpdrnRunMs: fastestRunMs(events, context.serverElapsedMs, context.minMsPerHand),
	}
}
