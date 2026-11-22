// The Teams rules: A against B, one shared pool of lives per team. Every rule is pure and
// reads the run. Every life change is the ledger's (lives.ts): it asks `lifePool`, and the
// pool drops once per losing team; `losersOf` only names the losing team's members.
import { type Ending, drawEnding, winEnding } from '../core/ending'
import { compareBlindScore, sum } from '../core/score'
import type { PlayerId, PvpBlind, Run, Team } from '../core/types'
import { statusAfterLives } from '../rules/lives'
import { inRunIgnoringLives } from '../rules/players'
import {
	aliveIds,
	aliveInPvpBlind,
	allOutOfHands,
	highestAnte,
	inRunWithLives,
	scoreOf,
	startingLives,
} from './common'
import type { LifePool, Mode, PvpCardTargets, RunStart } from './types'

type Side = 'A' | 'B'

const SIDES: Side[] = ['A', 'B']

const otherSide = (side: Side): Side => (side === 'A' ? 'B' : 'A')

const sideOfTeam = (team: Team | undefined): Side | null =>
	team === 'A' || team === 'B' ? team : null

// The server's team plan, `plan[0]` is team A and `plan[1]` team B. Ids
// that did not start are ignored; an id named twice stays with the later team.
function plannedTeams(start: RunStart): { [id: string]: Side } {
	const started = new Set(start.startedIds)
	const planned: { [id: string]: Side } = {}
	SIDES.forEach((side, position) => {
		for (const id of start.teamPlan?.[position] ?? [])
			if (started.has(id)) planned[id] = side
	})
	return planned
}

// The plan overrides a pick, a pick of A or B is kept (everyone on A is possible),
// and the rest go to the smaller team, a tie to A, walked in start order so the
// order of `start.picks` never matters.
export function assignTeams(start: RunStart): { [id: string]: Side } {
	const planned = plannedTeams(start)
	const teams: { [id: string]: Side } = {}
	for (const id of start.startedIds) {
		const side = planned[id] ?? sideOfTeam(start.picks[id])
		if (side !== null) teams[id] = side
	}
	const size = { A: 0, B: 0 }
	for (const side of Object.values(teams)) size[side]++
	for (const id of start.startedIds) {
		if (teams[id] !== undefined) continue
		const side: Side = size.B < size.A ? 'B' : 'A'
		teams[id] = side
		size[side]++
	}
	return teams
}

const membersOf = (
	teams: { [id: PlayerId]: Team },
	side: Side,
	ids: PlayerId[],
): PlayerId[] => ids.filter((id) => teams[id] === side)

// One random alive member of the other team (`alive` is sorted, so the candidates
// are too), null when that team has nobody alive.
function drawTarget(
	teams: { [id: PlayerId]: Team },
	mine: Side,
	alive: PlayerId[],
	random: () => number,
): PlayerId | null {
	const candidates = membersOf(teams, otherSide(mine), alive)
	return candidates.length === 0
		? null
		: candidates[Math.floor(random() * candidates.length)]
}

// The card targets: every alive player targets one random alive member of the
// other team (null when none). Players and candidates are walked sorted, so one random
// sequence always gives the same targets.
export function drawCardTargets(
	teams: { [id: PlayerId]: Team },
	alive: PlayerId[],
	ante: number,
	random: () => number,
): PvpCardTargets {
	const targets: { [id: string]: string | null } = {}
	for (const id of alive) {
		const mine = sideOfTeam(teams[id])
		if (mine === null) continue
		targets[id] = drawTarget(teams, mine, alive, random)
	}
	return { ante, targets }
}

// Shared roster first, then the teams, a pool of the starting lives per team, and the
// first card targets.
const init: Mode['init'] = (rules, start, random) => {
	const lives = startingLives(rules, start)
	const teams = assignTeams(start)
	return {
		lives,
		teams,
		teamLives: { A: rules.startingLives, B: rules.startingLives },
		cardTargets: drawCardTargets(
			teams,
			Object.keys(lives).filter((id) => inRunWithLives(lives[id])),
			1,
			random,
		),
	}
}

// A team's PvP blind score: the sum of its alive members' scores; null with no
// member reporting, which ranks below every real score.
function teamScore(
	run: Run,
	currentPvpBlind: PvpBlind,
	side: Side,
	alive: PlayerId[],
): string | null {
	const reported: string[] = []
	for (const id of membersOf(run.teams, side, alive)) {
		const score = scoreOf(currentPvpBlind, id)
		if (score !== null) reported.push(score)
	}
	return reported.length === 0 ? null : sum(reported)
}

// The team PvP blind: resolves once, when every alive player has no hands left. The
// higher team sum wins, equal sums cost nobody; the ledger takes the pool's life once per
// team and PvP blind.
function losersOf(run: Run, currentPvpBlind: PvpBlind): PlayerId[] | null {
	const alive = aliveInPvpBlind(run, currentPvpBlind)
	if (alive.length === 0 || !allOutOfHands(currentPvpBlind, alive)) return null
	const order = compareBlindScore(
		teamScore(run, currentPvpBlind, 'A', alive),
		teamScore(run, currentPvpBlind, 'B', alive),
	)
	if (order === 0) return []
	return membersOf(run.teams, order < 0 ? 'A' : 'B', alive)
}

// A team is out when its pool is empty or no member of it is still in the run.
function teamIsOut(run: Run, side: Side, pool: number): boolean {
	const members = Object.keys(run.lives).filter((id) => run.teams[id] === side)
	return pool <= 0 || !members.some((id) => inRunIgnoringLives(run.lives[id]))
}

// A team that is out loses, the other wins; both out is a draw. A game that
// starts with every player on one team ends at once for it.
function checkWinner(run: Run): Ending | null {
	if (run.teamLives === null) return null
	const teamAOut = teamIsOut(run, 'A', run.teamLives.A)
	const teamBOut = teamIsOut(run, 'B', run.teamLives.B)
	if (teamAOut && teamBOut) return drawEnding(run)
	if (teamAOut)
		return winEnding(run, membersOf(run.teams, 'B', Object.keys(run.lives)))
	if (teamBOut)
		return winEnding(run, membersOf(run.teams, 'A', Object.keys(run.lives)))
	return null
}

// New card targets once per new highest ante (ante 1 was drawn by `init`); a second call
// at the same ante changes nothing.
function onAnte(run: Run, random: () => number): Run {
	const ante = highestAnte(run)
	// No ante reported yet: nothing to draw for.
	if (ante === null) return run
	if (run.cardTargets !== null && ante <= run.cardTargets.ante) return run
	return {
		...run,
		cardTargets: drawCardTargets(run.teams, aliveIds(run), ante, random),
	}
}

// The stored card targets. There is no per-player opponent in Teams.
const view: Mode['view'] = (run) => ({
	opponents: {},
	pairingAnte: run.cardTargets?.ante ?? null,
	cardTargets: run.cardTargets?.targets ?? {},
})

// The two team sums of the PvP blind for the HUD, over every player of the run still alive.
const teamScores: NonNullable<Mode['teamScores']> = (run, currentPvpBlind) => {
	const alive = aliveIds(run)
	return {
		A: teamScore(run, currentPvpBlind, 'A', alive),
		B: teamScore(run, currentPvpBlind, 'B', alive),
	}
}

// A card reaches the stored target only.
const pickOpponents: Mode['pickOpponents'] = (_run, actor, shown) => {
	const one = shown.cardTargets?.[actor] ?? null
	return { one, each: one === null ? [] : [one] }
}

// The team's pool and the side it belongs to; null for a player on no team A/B or
// before `init` made the pools.
function poolOf(
	state: Run,
	id: string,
): { side: Side; pool: { A: number; B: number } } | null {
	const side = sideOfTeam(state.teams[id])
	const pool = state.teamLives
	return side === null || pool === null ? null : { side, pool }
}

// Every player's failure costs the team's pool one life, so two
// teammates failing one blind cost two. The ledger (lives.ts) owns the charges and the
// waiting death.
const lifePool: LifePool = {
	// The whole team of `id`, or nobody when it has no pool or the pool is already at 0.
	teamMemberIds: (state, id) => {
		const held = poolOf(state, id)
		if (!held || !state.lives[id] || held.pool[held.side] <= 0) return []
		return membersOf(state.teams, held.side, Object.keys(state.lives))
	},
	// One life off the pool of `id`'s team, shown on every player of that team
	// with the same event and the pool's value.
	takeLife: (state, id, cause) => {
		const held = poolOf(state, id)
		if (!held) return state
		const lives = held.pool[held.side] - 1
		const players = { ...state.lives }
		for (const member of membersOf(
			state.teams,
			held.side,
			Object.keys(players),
		))
			players[member] = {
				...players[member],
				lives,
				status: statusAfterLives(players[member].status, lives),
				events: [...players[member].events, { delta: -1, cause }],
			}
		return {
			...state,
			lives: players,
			teamLives: { ...held.pool, [held.side]: lives },
		}
	},
	// One loser per losing team (the smallest id, so the order of the losers cannot
	// matter): the team loses one life, not one per member.
	payers: (state, losers) => {
		const byTeam: { [team: string]: string } = {}
		for (const id of losers) {
			const team = state.teams[id]
			if (
				team !== undefined &&
				(byTeam[team] === undefined || id < byTeam[team])
			)
				byTeam[team] = id
		}
		return Object.values(byTeam).sort()
	},
}

export const teamsMode: Mode = {
	name: 'teams',
	pickableTeams: SIDES,
	// The pool of a team at 0 opens a waiting death that waits on the other team.
	deathWaitsOn: 'side',
	lifePool,
	pairs: 'none',
	init,
	losersOf,
	checkWinner,
	onAnte,
	view,
	teamScores,
	pickOpponents,
}
