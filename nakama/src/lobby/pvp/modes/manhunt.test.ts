import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { PvpBlind, Run, Team } from '../core/types'
import { settingsAtStart, withRules } from '../testing/rules'
import { lifePlayer, pvpBlindOf, runFor } from '../testing/view'
import { LAST_ANTE, RUNNER_LIVES, manhuntMode } from './manhunt'
import type { RunStart } from './types'

const requireRule = <T>(rule: T | undefined): T => {
	if (rule === undefined) throw new Error('manhunt defines this rule')
	return rule
}
const voucherGainers = requireRule(manhuntMode.voucherGainers)
const mayRedeemVoucher = requireRule(manhuntMode.mayRedeemVoucher)
const opensSideDeath = requireRule(manhuntMode.opensSideDeath)

type PlayerSetup = {
	team: Team
	score?: string
	hands?: number | null
	ante?: number
	lives?: number
	left?: boolean
	forfeited?: boolean
}

// A manhunt run with each player's team and report as given; `PvP blind` is null between
// blinds (the shop).
function manhuntPvpBlind(
	setups: { [id: string]: PlayerSetup },
	playing = true,
): { run: Run; currentPvpBlind: PvpBlind } {
	const ids = Object.keys(setups)
	const teams: { [id: string]: Team } = {}
	for (const id of ids) teams[id] = setups[id].team
	const base = runFor('manhunt', ids, {}, teams)
	const hunterLives = base.rules.hunterLives
	const lives: Run['lives'] = {}
	const players: Run['players'] = {}
	const reports: Parameters<typeof pvpBlindOf>[0] = {}
	for (const id of ids) {
		const setup = setups[id]
		lives[id] = lifePlayer({
			lives:
				setup.lives ?? (setup.team === 'RUNNER' ? RUNNER_LIVES : hunterLives),
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
		run: {
			...base,
			lives,
			players,
			currentPvpBlind: playing ? currentPvpBlind : null,
		},
		currentPvpBlind,
	}
}

const RUNNER_SETUP: PlayerSetup = { team: 'RUNNER' }
const HUNTER_SETUP: PlayerSetup = { team: 'HUNTER' }
const withScore = (setup: PlayerSetup, score: string): PlayerSetup => ({
	...setup,
	score,
})

const start = (
	startedIds: string[],
	picks: RunStart['picks'] = {},
): RunStart => ({ startedIds, picks, teamPlan: null })

describe('init', () => {
	const ids = ['a', 'b', 'c', 'd']
	const rulesFor = (started: string[]) =>
		settingsAtStart(withRules({ queue_mode: 'pvp_manhunt' }), started)
	const random = () => 0

	it.each<[string, RunStart, string]>([
		['the picker is the Runner', start(ids, { c: 'RUNNER' }), 'c'],
		[
			'the first of several pickers, in start order',
			start(ids, { d: 'RUNNER', b: 'RUNNER' }),
			'b',
		],
		['no picker: the first starter', start(ids), 'a'],
		['a Hunter pick changes nothing', start(ids, { c: 'HUNTER' }), 'a'],
	])('%s', (_name, run, runner) => {
		const out = manhuntMode.init(rulesFor(ids), run, random)
		const roles = Object.entries(out.teams)
		expect(roles.filter(([, t]) => t === 'RUNNER')).toEqual([
			[runner, 'RUNNER'],
		])
		expect(roles.filter(([, t]) => t === 'HUNTER')).toHaveLength(3)
	})

	it('the Runner has 1 life, every Hunter the ruleset hunter lives', () => {
		const rules = rulesFor(ids)
		const out = manhuntMode.init(rules, start(ids), random)
		expect(out.lives.a.lives).toBe(RUNNER_LIVES)
		for (const id of ['b', 'c', 'd'])
			expect(out.lives[id].lives).toBe(rules.hunterLives)
	})

	it('has no team pools and no card targets', () => {
		const out = manhuntMode.init(rulesFor(ids), start(ids), random)
		expect(out.teamLives).toBeNull()
		expect(out.cardTargets).toBeNull()
	})

	it('any picks give exactly one Runner and whole lives, whatever the key order', () => {
		const pick = fc.constantFrom<Team | undefined>(
			undefined,
			'RUNNER',
			'HUNTER',
			'A',
			'B',
		)
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 8 }),
				fc.array(pick, { minLength: 8, maxLength: 8 }),
				(count, picked) => {
					const started = Array.from({ length: count }, (_v, i) =>
						String.fromCharCode(97 + i),
					)
					const picks: RunStart['picks'] = {}
					started.forEach((id, index) => {
						const team = picked[index]
						if (team !== undefined) picks[id] = team
					})
					const reversed: RunStart['picks'] = {}
					for (const id of Object.keys(picks).reverse())
						reversed[id] = picks[id]
					const rules = rulesFor(started)
					const out = manhuntMode.init(rules, start(started, picks), random)
					const runners = Object.keys(out.teams).filter(
						(id) => out.teams[id] === 'RUNNER',
					)
					expect(runners).toEqual([
						started.find((id) => picks[id] === 'RUNNER') ?? started[0],
					])
					expect(Object.keys(out.teams).sort()).toEqual(started)
					for (const id of started)
						expect(out.lives[id].lives).toBe(
							id === runners[0] ? RUNNER_LIVES : rules.hunterLives,
						)
					expect(
						manhuntMode.init(rules, start(started, reversed), random),
					).toEqual(out)
				},
			),
		)
	})
})

describe('losersOf', () => {
	const losers = (setups: { [id: string]: PlayerSetup }) => {
		const { run, currentPvpBlind } = manhuntPvpBlind(setups)
		return manhuntMode.losersOf(run, currentPvpBlind)
	}

	it.each<[string, { [id: string]: PlayerSetup }, string[]]>([
		[
			'a Hunter below the Runner loses',
			{ r: withScore(RUNNER_SETUP, '9'), h: withScore(HUNTER_SETUP, '5') },
			['h'],
		],
		[
			'a Hunter ahead catches the Runner',
			{ r: withScore(RUNNER_SETUP, '5'), h: withScore(HUNTER_SETUP, '9') },
			['r'],
		],
		[
			'a tie costs the Hunter when the Runner scored',
			{ r: withScore(RUNNER_SETUP, '5'), h: withScore(HUNTER_SETUP, '5') },
			['h'],
		],
		[
			'0-0 costs nothing',
			{ r: withScore(RUNNER_SETUP, '0'), h: withScore(HUNTER_SETUP, '0') },
			[],
		],
		[
			'an unreported Hunter ranks below a Runner at 0',
			{ r: withScore(RUNNER_SETUP, '0'), h: HUNTER_SETUP },
			['h'],
		],
		[
			'two unreported tie and cost nothing',
			{ r: RUNNER_SETUP, h: HUNTER_SETUP },
			[],
		],
		[
			'scores compare as numbers, not text',
			{ r: withScore(RUNNER_SETUP, '9'), h: withScore(HUNTER_SETUP, '10') },
			['r'],
		],
		[
			'the Runner caught by one Hunter takes the others behind it down too',
			{
				r: withScore(RUNNER_SETUP, '5'),
				h1: withScore(HUNTER_SETUP, '9'),
				h2: withScore(HUNTER_SETUP, '3'),
			},
			['r', 'h2'],
		],
	])('%s', (_name, setups, expected) => {
		expect(losers(setups)).toEqual(expected)
	})

	it('waits while an alive player has hands; dead, forfeited and left players are not waited for', () => {
		expect(
			losers({
				r: withScore(RUNNER_SETUP, '9'),
				h: { ...HUNTER_SETUP, hands: 2 },
			}),
		).toBeNull()
		expect(
			losers({
				r: withScore(RUNNER_SETUP, '9'),
				h1: withScore(HUNTER_SETUP, '5'),
				h2: { ...HUNTER_SETUP, hands: 3, lives: 0 },
				h3: { ...HUNTER_SETUP, hands: 3, forfeited: true },
				h4: { ...HUNTER_SETUP, hands: 3, left: true },
			}),
		).toEqual(['h1'])
	})

	it('has no PvP blind to rank without an alive Runner or Hunter', () => {
		expect(
			losers({ r: RUNNER_SETUP, h: { ...HUNTER_SETUP, lives: 0 } }),
		).toBeNull()
		expect(
			losers({ r: { ...RUNNER_SETUP, lives: 0 }, h: HUNTER_SETUP }),
		).toBeNull()
	})
})

describe('vouchers', () => {
	const action = (playerId: string) => ({ playerId, voucherKey: 'v' })
	const teams: { [id: string]: Team } = {
		r: 'RUNNER',
		h1: 'HUNTER',
		h2: 'HUNTER',
		h3: 'HUNTER',
	}
	const state = runFor('manhunt', Object.keys(teams), {}, teams)

	it('the Runner voucher names every Hunter, anyone else names nobody', () => {
		expect(voucherGainers(state, action('r') as never)).toEqual([
			'h1',
			'h2',
			'h3',
		])
		expect(voucherGainers(state, action('h1') as never)).toEqual([])
		expect(voucherGainers(state, action('ghost') as never)).toEqual([])
	})

	it('only the Runner redeems', () => {
		expect(mayRedeemVoucher(state, 'r')).toBe(true)
		expect(mayRedeemVoucher(state, 'h1')).toBe(false)
		expect(mayRedeemVoucher(state, 'ghost')).toBe(false)
	})

	it('only a dying Runner opens a waiting death', () => {
		expect(opensSideDeath(state, 'r')).toBe(true)
		expect(opensSideDeath(state, 'h1')).toBe(false)
	})
})

describe('checkWinner', () => {
	const check = (setups: { [id: string]: PlayerSetup }, playing = true) =>
		manhuntMode.checkWinner(manhuntPvpBlind(setups, playing).run)
	const winners = (setups: { [id: string]: PlayerSetup }) =>
		check(setups)?.winners

	it('the Runner out of lives: the Hunters win', () => {
		expect(
			winners({ r: { ...RUNNER_SETUP, lives: 0 }, h: HUNTER_SETUP }),
		).toEqual(['h'])
	})

	it('no Hunter in the run with lives: the Runner wins', () => {
		expect(
			winners({ r: RUNNER_SETUP, h: { ...HUNTER_SETUP, lives: 0 } }),
		).toEqual(['r'])
		expect(
			winners({
				r: RUNNER_SETUP,
				h1: { ...HUNTER_SETUP, forfeited: true },
				h2: { ...HUNTER_SETUP, left: true },
			}),
		).toEqual(['r'])
	})

	it('the Runner is checked first when both sides are out', () => {
		expect(
			winners({
				r: { ...RUNNER_SETUP, lives: 0 },
				h: { ...HUNTER_SETUP, lives: 0 },
			}),
		).toEqual(['h'])
	})

	it('places the winners first and everyone else second', () => {
		expect(
			check({
				r: { ...RUNNER_SETUP, lives: 0 },
				h1: HUNTER_SETUP,
				h2: HUNTER_SETUP,
			})?.places,
		).toEqual({ h1: 1, h2: 1, r: 2 })
	})

	it('a Runner forfeit or leave hands the Hunters the win; one Hunter gone changes nothing', () => {
		expect(
			winners({ r: { ...RUNNER_SETUP, forfeited: true }, h: HUNTER_SETUP }),
		).toEqual(['h'])
		expect(
			winners({ r: { ...RUNNER_SETUP, left: true }, h: HUNTER_SETUP }),
		).toEqual(['h'])
		expect(
			check({
				r: RUNNER_SETUP,
				h1: { ...HUNTER_SETUP, forfeited: true },
				h2: HUNTER_SETUP,
			}),
		).toBeNull()
	})

	it.each<[string, number | undefined, boolean, boolean]>([
		['ante 9 between PvP blinds wins', LAST_ANTE + 1, false, true],
		['ante 8 is not enough', LAST_ANTE, false, false],
		['ante 9 mid-PvP blind waits', LAST_ANTE + 1, true, false],
		['no reported ante never wins', undefined, false, false],
	])('the Runner at the last ante: %s', (_name, ante, playing, wins) => {
		const out = check(
			{ r: { ...RUNNER_SETUP, ante }, h: HUNTER_SETUP },
			playing,
		)
		if (wins) expect(out?.winners).toEqual(['r'])
		else expect(out).toBeNull()
	})

	it("a Hunter's ante does not count", () => {
		expect(
			check({ r: RUNNER_SETUP, h: { ...HUNTER_SETUP, ante: 12 } }, false),
		).toBeNull()
	})

	it('has no Runner before init', () => {
		const { run } = manhuntPvpBlind({ r: RUNNER_SETUP, h: HUNTER_SETUP })
		expect(manhuntMode.checkWinner({ ...run, teams: {} })).toBeNull()
	})
})

describe('view', () => {
	const view = (setups: { [id: string]: PlayerSetup }) =>
		manhuntMode.view(manhuntPvpBlind(setups).run, null)

	it('every Hunter targets the Runner, the Runner the first alive Hunter by id', () => {
		expect(
			view({
				r: RUNNER_SETUP,
				h1: withScore(HUNTER_SETUP, '3'),
				h2: withScore(HUNTER_SETUP, '8'),
				h3: withScore(HUNTER_SETUP, '5'),
			}).opponents,
		).toEqual({ r: 'h1', h1: 'r', h2: 'r', h3: 'r' })
	})

	it('shows no score: the targets do not move with the scores', () => {
		const low = view({
			r: RUNNER_SETUP,
			h1: withScore(HUNTER_SETUP, '1'),
			h2: withScore(HUNTER_SETUP, '9'),
		})
		const high = view({
			r: RUNNER_SETUP,
			h1: withScore(HUNTER_SETUP, '9'),
			h2: withScore(HUNTER_SETUP, '1'),
		})
		expect(low).toEqual(high)
	})

	it('a Hunter out of the run is not a target, none left is null', () => {
		expect(
			view({
				r: RUNNER_SETUP,
				h1: { ...withScore(HUNTER_SETUP, '9'), lives: 0 },
				h2: withScore(HUNTER_SETUP, '1'),
			}).opponents.r,
		).toBe('h2')
		expect(
			view({ r: RUNNER_SETUP, h1: { ...HUNTER_SETUP, lives: 0 } }).opponents,
		).toEqual({ r: null, h1: 'r' })
	})

	it('shows nobody a target before the roster is settled', () => {
		const { run } = manhuntPvpBlind({ r: RUNNER_SETUP, h: HUNTER_SETUP })
		expect(manhuntMode.view({ ...run, teams: {} }, null)).toEqual({
			opponents: {},
		})
	})
})

describe('pickOpponents', () => {
	const { run } = manhuntPvpBlind({
		r: RUNNER_SETUP,
		h1: HUNTER_SETUP,
		h2: HUNTER_SETUP,
	})
	const shown = manhuntMode.view(run, null)

	it("a Runner's card reaches every Hunter, a Hunter's the Runner only", () => {
		expect(manhuntMode.pickOpponents(run, 'r', shown)).toEqual({
			one: 'h1',
			each: ['h1', 'h2'],
		})
		expect(manhuntMode.pickOpponents(run, 'h2', shown)).toEqual({
			one: 'r',
			each: ['r'],
		})
	})
})

describe('the mode contract', () => {
	it('waits the Runner death on the Hunters', () => {
		expect(manhuntMode.name).toBe('manhunt')
		expect(manhuntMode.deathWaitsOn).toBe('side')
	})
})
