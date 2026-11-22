import type { PvpBlind, PvpBlindPlayer, Run, Team } from '../core/types'
import type { PvpLifePlayer } from '../rules/lives'
import type { PvpMode } from '../rules/settings'
import { settingsAtStart, withRules } from './rules'
// Test support for the mode rules: literal runs, PvP blinds and players, with no plumbing.
import { runInMode } from './state'

export const QUEUE_OF: { [mode in PvpMode]: string } = {
	royale: 'pvp_royale',
	nemesis: 'pvp_nemesis',
	manhunt: 'pvp_manhunt',
	teams: 'pvp_teams',
}

// What a test says of one player's blind: a score, hands left, or hands used up by the
// server. A player with no hands left, or whose hands were used up, is done; one with no
// score and no hands has not entered.
export interface Report {
	score?: string | null
	handsLeft?: number | null
	handsUsedUp?: boolean
}

export function pvpBlindPlayerOf(report: Report): PvpBlindPlayer {
	const score = report.score ?? null
	const handsLeft = report.handsLeft ?? null
	if (report.handsUsedUp === true || handsLeft === 0)
		return { stage: 'done', endedBy: 'hands', handsLeft, score }
	if (score === null && handsLeft === null) return { stage: 'not entered' }
	return {
		stage: 'played a hand',
		handsLeft: handsLeft ?? 1,
		score: score ?? '0',
	}
}

// A PvP blind on ante 2 with the given players' reports.
export function pvpBlindOf(
	reports: { [id: string]: Report },
	blindKey: PvpBlind['blindKey'] = '2:Boss',
): PvpBlind {
	const players: PvpBlind['players'] = {}
	for (const id of Object.keys(reports))
		players[id] = pvpBlindPlayerOf(reports[id])
	return { blindKey, players, banks: {} }
}

export function lifePlayer(
	overrides: Partial<PvpLifePlayer> = {},
): PvpLifePlayer {
	return {
		lives: 4,
		status: 'playing',
		events: [],
		...overrides,
	}
}

// A run of `mode` for `ids`, everyone with the starting lives and no PvP blind playing.
export function runFor(
	mode: PvpMode,
	ids: string[],
	rules: { [key: string]: unknown } = {},
	teams: { [id: string]: Team } = {},
): Run {
	const settings = settingsAtStart(
		withRules({ queue_mode: QUEUE_OF[mode], ...rules }),
		ids,
	)
	const run = runInMode(ids, mode, teams).run
	if (run === null) throw new Error('no run')
	const lives: Run['lives'] = {}
	for (const id of ids)
		lives[id] = lifePlayer({ lives: settings.startingLives })
	return { ...run, rules: { ...run.rules, ...settings }, lives }
}

// The run with `changes` applied to each named player's lives.
export function withLives(
	run: Run,
	changes: { [id: string]: Partial<PvpLifePlayer> },
): Run {
	const lives = { ...run.lives }
	for (const id of Object.keys(changes))
		lives[id] = { ...lives[id], ...changes[id] }
	return { ...run, lives }
}

// A scripted random source: the given draws in order, then the last one for ever.
export function scriptedRandom(randoms: number[] = [0]): () => number {
	let next = 0
	return () => randoms[Math.min(next++, randoms.length - 1)]
}
