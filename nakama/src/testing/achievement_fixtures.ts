// Achievement test data: a player's log facts and a stored run between
// players A and B, each a normal finished game unless overridden.
import type { LogFacts } from '../achievements/facts'
import type { RunRecord } from '../lobby/protocol'

export const A = 'aaaaaaaa-0000-4000-8000-000000000001'
export const B = 'bbbbbbbb-0000-4000-8000-000000000002'
export const C = 'cccccccc-0000-4000-8000-000000000003'

export function facts(over: Partial<LogFacts> = {}): LogFacts {
	return {
		hands: 5,
		rerolls: 0,
		skips: 0,
		moneySpent: 0,
		suitChangers: 0,
		livesLost: 0,
		bestHandScore: 0,
		setup: { decks: ['b_red'], smallworld: false, spdrnMode: null },
		fastestSpdrnRunMs: null,
		...over,
	}
}

export function runOf(over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: 'run-1',
		code: 'ABCDEF',
		modId: 'MultiplayerPvP',
		seed: 'S',
		stake: 1,
		options: null,
		startedAt: Date.UTC(2026, 9, 19, 12),
		endedAt: Date.UTC(2026, 9, 19, 12) + 10 * 60 * 1000,
		status: 'agreed',
		placements: [
			{ playerId: A, place: 1 },
			{ playerId: B, place: 2 },
		],
		reports: {},
		players: [
			{ id: A, displayName: 'A' },
			{ id: B, displayName: 'B' },
		],
		lobbyType: 'public',
		flags: {},
		...over,
	}
}
