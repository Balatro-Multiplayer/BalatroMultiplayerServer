import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { PvpBlind, Run, Team } from '../core/types'
import { chargeLife } from '../rules/lives'
import { settingsAtStart, withRules } from '../testing/rules'
import { lifePlayer, pvpBlindOf, runFor, scriptedRandom } from '../testing/view'
import { aliveIds } from './common'
import { assignTeams, drawCardTargets, teamsMode } from './teams'
import type { RunStart } from './types'

const requireRule = <T>(rule: T | undefined): T => {
	if (rule === undefined) throw new Error('teams defines this rule')
	return rule
}
const onAnte = requireRule(teamsMode.onAnte)
const teamScores = requireRule(teamsMode.teamScores)
const lifePool = requireRule(teamsMode.lifePool)

// One failing player charged through the ledger, which owns the pool-at-0 guard.
function chargedThroughLedger(run: Run, id: string): Run {
	return chargeLife(run, teamsMode, id, { kind: 'timer_ran_out' })
}

type PlayerSetup = {
	team: 'A' | 'B'
	score?: string
	hands?: number | null
	ante?: number
	lives?: number
	left?: boolean
	forfeited?: boolean
}

// A teams run mid-PvP blind: pools at 4, each player's team and report as given.
function teamsPvpBlind(
	setups: { [id: string]: PlayerSetup },
	pool = { A: 4, B: 4 },
): { run: Run; currentPvpBlind: PvpBlind } {
	const ids = Object.keys(setups)
	const teams: { [id: string]: Team } = {}
	for (const id of ids) teams[id] = setups[id].team
	const base = runFor('teams', ids, {}, teams)
	const lives: Run['lives'] = {}
	const players: Run['players'] = {}
	const reports: Parameters<typeof pvpBlindOf>[0] = {}
	for (const id of ids) {
		const setup = setups[id]
		lives[id] = lifePlayer({
			lives: setup.lives ?? pool[setup.team],
			status: setup.forfeited ? 'forfeited' : setup.left ? 'left' : 'playing',
		})
		players[id] = { ...base.players[id], ante: setup.ante ?? null }
		reports[id] = {
			score: setup.score ?? null,
			handsLeft: setup.hands === undefined ? 0 : setup.hands,
		}
	}
	const currentPvpBlind = pvpBlindOf(reports)
	return {
		run: { ...base, lives, players, teamLives: pool, currentPvpBlind },
		currentPvpBlind,
	}
}

// The run as the ledger reads it: pools and lives, no PvP blind.
function teamsLedger(
	setups: { [id: string]: PlayerSetup },
	pool = { A: 4, B: 4 },
): Run {
	const ids = Object.keys(setups)
	const teams: { [id: string]: Team } = {}
	for (const id of ids) teams[id] = setups[id].team
	const base = runFor('teams', ids, {}, teams)
	const lives = { ...base.lives }
	for (const id of ids) {
		const setup = setups[id]
		lives[id] = lifePlayer({
			lives: setup.lives ?? pool[setup.team],
			status: setup.forfeited ? 'forfeited' : setup.left ? 'left' : 'playing',
		})
	}
	return { ...base, lives, teamLives: pool }
}

const FOUR_PLAYERS: { [id: string]: PlayerSetup } = {
	a1: { team: 'A', score: '5' },
	a2: { team: 'A', score: '5' },
	b1: { team: 'B', score: '3' },
	b2: { team: 'B', score: '1' },
}

const start = (
	startedIds: string[],
	picks: RunStart['picks'] = {},
	teamPlan: string[][] | null = null,
): RunStart => ({ startedIds, picks, teamPlan })

describe('assignTeams', () => {
	it.each<[string, RunStart, { [id: string]: string }]>([
		[
			'an unpicked 4 splits evenly, ties to A',
			start(['a', 'b', 'c', 'd']),
			{ a: 'A', b: 'B', c: 'A', d: 'B' },
		],
		[
			'an unpicked 5 splits 3 against 2',
			start(['a', 'b', 'c', 'd', 'e']),
			{ a: 'A', b: 'B', c: 'A', d: 'B', e: 'A' },
		],
		[
			'a pick is kept and the rest fill the smaller team',
			start(['a', 'b', 'c'], { a: 'B', b: 'B' }),
			{ a: 'B', b: 'B', c: 'A' },
		],
		[
			'everyone may pick the same team',
			start(['a', 'b'], { a: 'A', b: 'A' }),
			{ a: 'A', b: 'A' },
		],
		[
			'a plan beats a pick',
			start(['a', 'b'], { a: 'A', b: 'A' }, [['b'], ['a']]),
			{ a: 'B', b: 'A' },
		],
		[
			'a plan names only the started',
			start(['a', 'b'], {}, [
				['a', 'x'],
				['b', 'y'],
			]),
			{ a: 'A', b: 'B' },
		],
		[
			'a role pick is not a team',
			start(['a', 'b'], { a: 'RUNNER' }),
			{ a: 'A', b: 'B' },
		],
	])('%s', (_name, run, expected) => {
		expect(assignTeams(run)).toEqual(expected)
	})

	it('does not depend on the key order of the picks', () => {
		const one = start(['a', 'b', 'c', 'd'], { a: 'B', d: 'A' })
		const two = start(['a', 'b', 'c', 'd'], { d: 'A', a: 'B' })
		expect(assignTeams(two)).toEqual(assignTeams(one))
	})
})

describe('init', () => {
	const ids = ['a', 'b', 'c', 'd']
	const rules = settingsAtStart(withRules({ queue_mode: 'pvp_teams' }), ids)
	const planned = start(ids, {}, [
		['a', 'b'],
		['c', 'd'],
	])

	it('players everyone, assigns the teams, pools the starting lives, draws targets', () => {
		const out = teamsMode.init(rules, planned, scriptedRandom([0]))
		expect(out.teams).toEqual({ a: 'A', b: 'A', c: 'B', d: 'B' })
		expect(Object.keys(out.lives)).toEqual(ids)
		expect(out.teamLives).toEqual({
			A: rules.startingLives,
			B: rules.startingLives,
		})
		expect(out.cardTargets).toEqual({
			ante: 1,
			targets: { a: 'c', b: 'c', c: 'a', d: 'a' },
		})
	})

	it('gives the same opening for the same input', () => {
		expect(teamsMode.init(rules, planned, scriptedRandom([0.7, 0.2]))).toEqual(
			teamsMode.init(rules, planned, scriptedRandom([0.7, 0.2])),
		)
	})
})

describe('losersOf', () => {
	const losers = (setups: { [id: string]: PlayerSetup }): string[] | null => {
		const { run, currentPvpBlind } = teamsPvpBlind(setups)
		return teamsMode.losersOf(run, currentPvpBlind)
	}

	it('the lower team sum loses, every member named', () => {
		expect(losers(FOUR_PLAYERS)).toEqual(['b1', 'b2'])
	})

	it('equal sums cost nobody', () => {
		expect(
			losers({
				a1: { team: 'A', score: '4' },
				b1: { team: 'B', score: '1' },
				b2: { team: 'B', score: '3' },
			}),
		).toEqual([])
	})

	it('compares sums as Talisman numbers, not as text', () => {
		expect(
			losers({
				a1: { team: 'A', score: '9' },
				b1: { team: 'B', score: '10' },
			}),
		).toEqual(['a1'])
	})

	it('a team with no reports loses to a real 0, and two empty teams tie', () => {
		expect(
			losers({ a1: { team: 'A', hands: 0 }, b1: { team: 'B', score: '0' } }),
		).toEqual(['a1'])
		expect(losers({ a1: { team: 'A' }, b1: { team: 'B' } })).toEqual([])
	})

	it('leaves out members who forfeited, left or are dead, and does not wait on them', () => {
		expect(
			losers({
				a1: { team: 'A', score: '1' },
				a2: { team: 'A', score: '100', forfeited: true, hands: 3 },
				b1: { team: 'B', score: '2' },
				b2: { team: 'B', score: '100', left: true, hands: 3 },
				b3: { team: 'B', score: '100', lives: 0, hands: 3 },
			}),
		).toEqual(['a1'])
	})

	it('waits while any alive member has hands', () => {
		expect(
			losers({ ...FOUR_PLAYERS, b2: { team: 'B', score: '9', hands: 1 } }),
		).toBeNull()
	})
})

describe('lifePool', () => {
	it('teammates: the whole team, nobody at an empty pool or off a team', () => {
		const state = teamsLedger(FOUR_PLAYERS)
		expect(lifePool.teamMemberIds(state, 'a1')).toEqual(['a1', 'a2'])
		const empty = teamsLedger(FOUR_PLAYERS, { A: 0, B: 4 })
		expect(lifePool.teamMemberIds(empty, 'a1')).toEqual([])
		expect(lifePool.teamMemberIds(empty, 'b1')).toEqual(['b1', 'b2'])
		expect(lifePool.teamMemberIds({ ...state, teamLives: null }, 'a1')).toEqual(
			[],
		)
		expect(lifePool.teamMemberIds(state, 'ghost')).toEqual([])
	})

	it('charge: one life off the pool, mirrored with one event on every member', () => {
		const out = lifePool.takeLife(teamsLedger(FOUR_PLAYERS), 'a2', 'k')
		expect(out.teamLives).toEqual({ A: 3, B: 4 })
		for (const id of ['a1', 'a2']) {
			expect(out.lives[id].lives).toBe(3)
			expect(out.lives[id].events).toEqual([{ delta: -1, cause: 'k' }])
		}
		expect(out.lives.b1.lives).toBe(4)
	})

	it('charge: the last life eliminates the team, and an unpooled player is untouched', () => {
		const out = lifePool.takeLife(
			teamsLedger(FOUR_PLAYERS, { A: 1, B: 4 }),
			'a1',
			null,
		)
		expect(out.teamLives).toEqual({ A: 0, B: 4 })
		expect(out.lives.a1.status).toBe('out')
		expect(out.lives.a2.status).toBe('out')
		const state = teamsLedger(FOUR_PLAYERS)
		expect(lifePool.takeLife(state, 'ghost', 'k')).toBe(state)
	})

	it('payers: one per losing team, the smallest id, whatever the order', () => {
		const state = teamsLedger(FOUR_PLAYERS)
		expect(lifePool.payers(state, ['b2', 'b1'])).toEqual(['b1'])
		expect(lifePool.payers(state, ['b1', 'b2'])).toEqual(['b1'])
		expect(lifePool.payers(state, ['b2', 'a2', 'a1', 'ghost'])).toEqual([
			'a1',
			'b2',
		])
		expect(lifePool.payers(state, [])).toEqual([])
	})
})

describe('checkWinner', () => {
	const check = (
		setups: { [id: string]: PlayerSetup },
		pool?: { A: number; B: number },
	) => teamsMode.checkWinner(teamsPvpBlind(setups, pool).run)

	it('a team whose pool is empty loses', () => {
		expect(check(FOUR_PLAYERS, { A: 2, B: 0 })?.winners).toEqual(['a1', 'a2'])
		expect(check(FOUR_PLAYERS, { A: 0, B: 2 })?.winners).toEqual(['b1', 'b2'])
	})

	it('places the winning team first and the other second', () => {
		expect(check(FOUR_PLAYERS, { A: 2, B: 0 })?.places).toEqual({
			a1: 1,
			a2: 1,
			b1: 2,
			b2: 2,
		})
	})

	it('both pools empty is a draw', () => {
		expect(check(FOUR_PLAYERS, { A: 0, B: 0 })?.winners).toBeNull()
	})

	it('a team with nobody left in the run loses, a left player counts as gone', () => {
		expect(
			check({
				...FOUR_PLAYERS,
				b1: { team: 'B', forfeited: true },
				b2: { team: 'B', left: true },
			})?.winners,
		).toEqual(['a1', 'a2'])
	})

	it('a start with everyone on one team ends at once for it', () => {
		expect(check({ a1: { team: 'A' }, a2: { team: 'A' } })?.winners).toEqual([
			'a1',
			'a2',
		])
	})

	it('one member gone changes nothing', () => {
		expect(
			check({ ...FOUR_PLAYERS, b1: { team: 'B', forfeited: true } }),
		).toBeNull()
	})

	it('waits on a missing pool', () => {
		const { run } = teamsPvpBlind(FOUR_PLAYERS, { A: 0, B: 2 })
		expect(teamsMode.checkWinner({ ...run, teamLives: null })).toBeNull()
	})
})

describe('card targets', () => {
	it('every alive player targets an alive member of the other team', () => {
		const { run } = teamsPvpBlind({
			...FOUR_PLAYERS,
			b2: { team: 'B', lives: 0 },
		})
		for (const randomValue of [0, 0.4, 0.99]) {
			const { targets } = drawCardTargets(
				run.teams,
				aliveIds(run),
				1,
				() => randomValue,
			)
			expect(Object.keys(targets).sort()).toEqual(['a1', 'a2', 'b1'])
			for (const [id, target] of Object.entries(targets)) {
				expect(target).not.toBeNull()
				expect(run.teams[id]).not.toBe(run.teams[target ?? ''])
			}
			expect(targets.b1).toMatch(/^a/)
			expect(targets.a1).toBe('b1')
		}
	})

	it('is null when the other team has nobody alive, and the same for the same draws', () => {
		const alone = teamsPvpBlind({ a1: { team: 'A' }, a2: { team: 'A' } }).run
		expect(drawCardTargets(alone.teams, aliveIds(alone), 2, () => 0)).toEqual({
			ante: 2,
			targets: { a1: null, a2: null },
		})
		const draws = [0.1, 0.9, 0.5, 0.2]
		const seq = () => {
			let callCount = 0
			return () => draws[callCount++ % draws.length]
		}
		const { run } = teamsPvpBlind(FOUR_PLAYERS)
		expect(drawCardTargets(run.teams, aliveIds(run), 1, seq())).toEqual(
			drawCardTargets(run.teams, aliveIds(run), 1, seq()),
		)
	})

	it('onAnte draws once per new highest ante, and not before one is reported', () => {
		const { run } = teamsPvpBlind(FOUR_PLAYERS)
		expect(onAnte(run, scriptedRandom())).toBe(run)
		const reported = teamsPvpBlind({
			...FOUR_PLAYERS,
			a1: { team: 'A', ante: 2 },
		}).run
		const drawn = onAnte(reported, scriptedRandom())
		expect(drawn.cardTargets?.ante).toBe(2)
		expect(onAnte(drawn, scriptedRandom())).toBe(drawn)
		const held = { ...reported, cardTargets: { ante: 3, targets: {} } }
		expect(onAnte(held, scriptedRandom())).toBe(held)
	})
})

describe('view', () => {
	it('shows the stored card targets and the ante they were drawn for', () => {
		const { run } = teamsPvpBlind(FOUR_PLAYERS)
		const held = { ...run, cardTargets: { ante: 1, targets: { a1: 'b1' } } }
		expect(teamsMode.view(held, 1)).toEqual({
			opponents: {},
			pairingAnte: 1,
			cardTargets: { a1: 'b1' },
		})
	})

	it('shows no card targets before any are drawn', () => {
		const { run } = teamsPvpBlind(FOUR_PLAYERS)
		expect(teamsMode.view({ ...run, cardTargets: null }, null)).toEqual({
			opponents: {},
			pairingAnte: null,
			cardTargets: {},
		})
	})
})

describe('teamScores', () => {
	it('shows both team sums', () => {
		const { run, currentPvpBlind } = teamsPvpBlind(FOUR_PLAYERS)
		expect(teamScores(run, currentPvpBlind)).toEqual({ A: '10', B: '4' })
	})

	it('a team with no score shows null, a dead member is left out', () => {
		const { run, currentPvpBlind } = teamsPvpBlind({
			a1: { team: 'A' },
			b1: { team: 'B', score: '4' },
			b2: { team: 'B', score: '9', lives: 0 },
		})
		expect(teamScores(run, currentPvpBlind)).toEqual({ A: null, B: '4' })
	})

	it('sums as losersOf ranks', () => {
		const { run, currentPvpBlind } = teamsPvpBlind(FOUR_PLAYERS)
		expect(teamScores(run, currentPvpBlind)).toEqual({ A: '10', B: '4' })
		expect(teamsMode.losersOf(run, currentPvpBlind)).toEqual(['b1', 'b2'])
	})
})

describe('the mode contract', () => {
	it('waits a pool at 0 on the other side', () => {
		expect(teamsMode.name).toBe('teams')
		expect(teamsMode.deathWaitsOn).toBe('side')
		expect(teamsMode.pairs).toBe('none')
	})
})

describe('team rules hold for any players', () => {
	const ids = fc
		.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), {
			minLength: 2,
			maxLength: 8,
		})
		.map((list) => list.sort())
	const pick = fc.constantFrom<Team | undefined>('A', 'B', 'RUNNER', undefined)

	it('every started player is on exactly one team, and the key order of picks is no input', () => {
		fc.assert(
			fc.property(
				ids,
				fc.array(pick, { minLength: 8, maxLength: 8 }),
				(started, picked) => {
					const picks: RunStart['picks'] = {}
					started.forEach((id, index) => {
						const team = picked[index]
						if (team !== undefined) picks[id] = team
					})
					const teams = assignTeams(start(started, picks))
					expect(Object.keys(teams).sort()).toEqual(started)
					const reversed: RunStart['picks'] = {}
					for (const id of Object.keys(picks).reverse())
						reversed[id] = picks[id]
					expect(assignTeams(start(started, reversed))).toEqual(teams)
				},
			),
		)
	})

	it('a plan beats a pick, and a pick beats the balance', () => {
		fc.assert(
			fc.property(ids, (started) => {
				const plan = [
					started.filter((_id, i) => i % 3 === 0),
					started.filter((_id, i) => i % 3 !== 0),
				]
				const allA: RunStart['picks'] = {}
				for (const id of started) allA[id] = 'A'
				const planned = assignTeams(start(started, allA, plan))
				for (const id of plan[0]) expect(planned[id]).toBe('A')
				for (const id of plan[1]) expect(planned[id]).toBe('B')
				const picked = assignTeams(start(started, allA))
				for (const id of started) expect(picked[id]).toBe('A')
			}),
		)
	})

	it('an unpicked start splits within one player', () => {
		fc.assert(
			fc.property(ids, (started) => {
				const teams = Object.values(assignTeams(start(started)))
				const onA = teams.filter((team) => team === 'A').length
				expect(Math.abs(onA - (teams.length - onA))).toBeLessThanOrEqual(1)
			}),
		)
	})

	it('a player is never a card target of a teammate', () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom<'A' | 'B'>('A', 'B'), {
					minLength: 2,
					maxLength: 8,
				}),
				fc.double({ min: 0, max: 0.999, noNaN: true }),
				(sides, draw) => {
					const setups: { [id: string]: PlayerSetup } = {}
					sides.forEach((team, index) => {
						setups[`p${index}`] = { team }
					})
					const { run } = teamsPvpBlind(setups)
					const { targets } = drawCardTargets(
						run.teams,
						aliveIds(run),
						1,
						() => draw,
					)
					for (const [id, target] of Object.entries(targets))
						if (target !== null)
							expect(run.teams[target]).not.toBe(run.teams[id])
				},
			),
		)
	})

	it('lives mirror the pool, never go below 0, and a charge ends at the last life', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 0, max: 6 }),
				(pool, charges) => {
					let state = teamsLedger(FOUR_PLAYERS, { A: pool, B: 4 })
					for (let n = 0; n < charges; n++)
						state = chargedThroughLedger(state, 'a1')
					const expected = Math.max(0, pool - charges)
					expect(state.teamLives).toEqual({ A: expected, B: 4 })
					for (const id of ['a1', 'a2']) {
						expect(state.lives[id].lives).toBe(expected)
						expect(state.lives[id].status).toBe(
							pool > 0 && charges > 0 && expected === 0 ? 'out' : 'playing',
						)
					}
					expect(state.lives.b1.lives).toBe(4)
				},
			),
		)
	})

	it('the losers do not depend on the order the players are listed in', () => {
		fc.assert(
			fc.property(
				fc.array(fc.nat({ max: 50 }).map(String), {
					minLength: 4,
					maxLength: 4,
				}),
				(scores) => {
					const forward = teamsPvpBlind({
						a1: { team: 'A', score: scores[0] },
						a2: { team: 'A', score: scores[1] },
						b1: { team: 'B', score: scores[2] },
						b2: { team: 'B', score: scores[3] },
					})
					const reversed = teamsPvpBlind({
						b2: { team: 'B', score: scores[3] },
						b1: { team: 'B', score: scores[2] },
						a2: { team: 'A', score: scores[1] },
						a1: { team: 'A', score: scores[0] },
					})
					expect(
						teamsMode.losersOf(reversed.run, reversed.currentPvpBlind),
					).toEqual(teamsMode.losersOf(forward.run, forward.currentPvpBlind))
				},
			),
		)
	})
})

describe('team rules, named cases', () => {
	it('a pool of 1 charged for two failing teammates goes to 0, not below', () => {
		const state = teamsLedger(FOUR_PLAYERS, { A: 1, B: 4 })
		const once = chargedThroughLedger(state, 'a1')
		const twice = chargedThroughLedger(once, 'a2')
		expect(twice.teamLives).toEqual({ A: 0, B: 4 })
		expect(twice.lives.a1.lives).toBe(0)
		expect(twice.lives.a2.lives).toBe(0)
	})

	it('a charge on a team whose pool is at 0 returns the state unchanged', () => {
		const state = teamsLedger(FOUR_PLAYERS, { A: 0, B: 4 })
		const charged = chargedThroughLedger(state, 'a1')
		expect(charged.lives).toBe(state.lives)
		expect(charged.currentPvpBlind).toBe(state.currentPvpBlind)
	})

	it('players are walked in start order, so the smaller team is filled in that order', () => {
		expect(assignTeams(start(['e', 'd', 'c', 'b', 'a']))).toEqual({
			e: 'A',
			d: 'B',
			c: 'A',
			b: 'B',
			a: 'A',
		})
	})
})
