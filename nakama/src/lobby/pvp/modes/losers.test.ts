// For every mode and for the final-two variants: when every alive player is out of
// hands and a contest is left to rank, losersOf names the losers (possibly none), whatever
// scores were reported (a player who never reported has none). A null answer there would
// stall the game: the PvP blind would never end.
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Team } from '../core/types'
import type { PvpLifePlayer } from '../rules/lives'
import type { PvpMode } from '../rules/settings'
import { type Report, pvpBlindOf, runFor, withLives } from '../testing/view'
import { aliveIds } from './common'
import { pickMode } from './index'
import type { Mode } from './types'

interface Setup {
	name: string
	mode: PvpMode
	// The players that have left before the PvP blind (the final-two variants).
	left: string[]
	picked: () => Mode
	// Whether the alive players still make a contest the mode must rank.
	hasContest: (alive: string[]) => boolean
	ids: string[]
	rules: { [key: string]: unknown }
	teams: { [id: string]: Team }
}

const atLeast =
	(count: number) =>
	(alive: string[]): boolean =>
		alive.length >= count

const SETUPS: Setup[] = [
	{
		name: 'duel',
		mode: 'nemesis',
		left: [],
		picked: () => pickMode('nemesis', 2),
		hasContest: atLeast(2),
		ids: ['a', 'b'],
		rules: {},
		teams: {},
	},
	{
		name: 'royale',
		mode: 'royale',
		left: [],
		picked: () => pickMode('royale', 3),
		hasContest: atLeast(2),
		ids: ['a', 'b', 'c'],
		rules: {},
		teams: {},
	},
	{
		name: 'royale, final two',
		mode: 'royale',
		left: ['c', 'd'],
		picked: () => pickMode('royale', 4, 2),
		hasContest: (alive) => alive.length === 2,
		ids: ['a', 'b', 'c', 'd'],
		rules: {},
		teams: {},
	},
	{
		name: 'nemesis',
		mode: 'nemesis',
		left: [],
		picked: () => pickMode('nemesis', 3),
		hasContest: atLeast(2),
		ids: ['a', 'b', 'c'],
		rules: {},
		teams: {},
	},
	{
		name: 'nemesis, final two',
		mode: 'nemesis',
		left: ['c', 'd'],
		picked: () => pickMode('nemesis', 4, 2),
		hasContest: (alive) => alive.length === 2,
		ids: ['a', 'b', 'c', 'd'],
		rules: {},
		teams: {},
	},
	{
		name: 'manhunt',
		mode: 'manhunt',
		left: [],
		picked: () => pickMode('manhunt', 4),
		// a is the Runner: it and at least one Hunter must be alive
		hasContest: (alive) => alive.includes('a') && alive.length >= 2,
		ids: ['a', 'b', 'c', 'd'],
		rules: { manhunt_hunter_lives: 3 },
		teams: { a: 'RUNNER', b: 'HUNTER', c: 'HUNTER', d: 'HUNTER' },
	},
	{
		name: 'teams',
		mode: 'teams',
		left: [],
		picked: () => pickMode('teams', 4),
		hasContest: atLeast(1),
		ids: ['a', 'b', 'c', 'd'],
		rules: {},
		teams: { a: 'A', b: 'A', c: 'B', d: 'B' },
	},
]

// How a player's hands ended: the count reached 0 with a reported score, or the
// server spent them, with or without a report.
const doneEntry: fc.Arbitrary<Report> = fc.oneof(
	fc.record({
		score: fc.nat(1000).map(String),
		handsLeft: fc.constant(0),
	}),
	fc.record({
		score: fc.option(fc.nat(1000).map(String), { nil: null }),
		handsLeft: fc.option(fc.nat(4), { nil: null }),
		handsUsedUp: fc.constant(true),
	}),
)

// How a player can be out of the run: still in, forfeited, eliminated, at 0 lives.
const OUT_OF_RUN: { [status: string]: Partial<PvpLifePlayer> } = {
	alive: {},
	forfeited: { status: 'forfeited' },
	eliminated: { status: 'out', lives: 0 },
	zero: { lives: 0 },
}
const status = fc.oneof(
	{ arbitrary: fc.constant('alive'), weight: 4 },
	{ arbitrary: fc.constantFrom('forfeited', 'eliminated', 'zero'), weight: 1 },
)

describe.each(SETUPS)('losersOf ($name)', (setup) => {
	const base = {
		...runFor(setup.mode, setup.ids, setup.rules, setup.teams),
	}
	const withTeamPools = {
		...base,
		teamLives: setup.mode === 'teams' ? { A: 4, B: 4 } : null,
	}

	it('starts with everyone alive', () => {
		expect(aliveIds(withTeamPools)).toEqual(setup.ids)
	})

	it('names the losers whenever a contest is left and every alive player is out of hands', () => {
		const mode = setup.picked()
		fc.assert(
			fc.property(
				fc.array(fc.tuple(doneEntry, status), {
					minLength: setup.ids.length,
					maxLength: setup.ids.length,
				}),
				(players) => {
					const reports: { [id: string]: Report } = {}
					const changes: { [id: string]: Partial<PvpLifePlayer> } = {}
					setup.ids.forEach((id, index) => {
						const [entry, outOfRun] = players[index]
						reports[id] = entry
						changes[id] = setup.left.includes(id)
							? { status: 'left' }
							: OUT_OF_RUN[outOfRun]
					})
					const run = withLives(withTeamPools, changes)
					const losers = mode.losersOf(run, pvpBlindOf(reports))
					if (setup.hasContest(aliveIds(run))) expect(losers).not.toBeNull()
				},
			),
			{ numRuns: 300 },
		)
	})
})
