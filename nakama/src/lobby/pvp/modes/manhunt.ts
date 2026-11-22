// The Manhunt rules: one Runner against the Hunters. Every rule is pure and reads the run.
// A mode only names people: the ledger (lives.ts) takes and gives every life.
import { type Ending, winEnding } from '../core/ending'
import { SCORE_ZERO, compareBlindScore, greater } from '../core/score'
import type { PlayerId, PvpBlind, Run, Team } from '../core/types'
import { allOutOfHands, isAlive, scoreOf, startingLives } from './common'
import type { Mode, Opponents, TargetsShown } from './types'

export const RUNNER_LIVES = 1

// The Runner wins on reaching ante 9, one past this.
export const LAST_ANTE = 8

function onTeam(teams: { [id: PlayerId]: Team }, team: Team): PlayerId[] {
	return Object.keys(teams)
		.filter((id) => teams[id] === team)
		.sort()
}

// The Runner of the run, settled by `init`.
const runnerOf = (run: Run): PlayerId | null =>
	onTeam(run.teams, 'RUNNER')[0] ?? null

const hunterIds = (run: Run): PlayerId[] => onTeam(run.teams, 'HUNTER')

const aliveHunters = (run: Run): PlayerId[] =>
	hunterIds(run).filter((id) => isAlive(run, id))

// The Runner is the first starter who picked RUNNER, else the first starter. Start
// order, not the order the picks arrived in. Everyone else is a Hunter, whatever they
// picked; the team plan is for Teams. The Runner has 1 life, a Hunter `hunterLives`.
const init: Mode['init'] = (rules, start) => {
	const runner =
		start.startedIds.find((id) => start.picks[id] === 'RUNNER') ??
		start.startedIds[0]
	const lives = startingLives(rules, start)
	const teams: { [id: PlayerId]: Team } = {}
	for (const id of start.startedIds) {
		teams[id] = id === runner ? 'RUNNER' : 'HUNTER'
		lives[id] = {
			...lives[id],
			lives: id === runner ? RUNNER_LIVES : rules.hunterLives,
		}
	}
	return { lives, teams, teamLives: null, cardTargets: null }
}

// A Hunter loses to a lower score, or to a tie with a
// Runner who scored; 0-0 costs nothing. An unreported score ranks below every
// reported one (compareBlindScore), so it never ties a scored Runner.
const behindRunner = (
	hunter: string | null,
	runner: string | null,
): boolean => {
	const order = compareBlindScore(runner, hunter)
	return (
		order === 1 ||
		(order === 0 && runner !== null && greater(runner, SCORE_ZERO))
	)
}

// The PvP blind resolves once, when EVERY alive player has no hands left; a dead, forfeited
// or left player is never waited for. With no Runner or no Hunter alive there is no PvP blind
// to rank: the game is ending. The Hunters behind the Runner lose; the Runner loses only
// to a Hunter strictly ahead of it, so a tie never catches it.
function losersOf(run: Run, currentPvpBlind: PvpBlind): PlayerId[] | null {
	const runner = runnerOf(run)
	const inPvpBlind = (id: PlayerId): boolean =>
		currentPvpBlind.players[id] !== undefined && isAlive(run, id)
	if (runner === null || !inPvpBlind(runner)) return null
	const hunters = aliveHunters(run).filter(inPvpBlind)
	if (hunters.length === 0) return null
	if (!allOutOfHands(currentPvpBlind, [runner, ...hunters])) return null
	const runnerScore = scoreOf(currentPvpBlind, runner)
	const behind = hunters.filter((id) =>
		behindRunner(scoreOf(currentPvpBlind, id), runnerScore),
	)
	const caught = hunters.some(
		(id) => compareBlindScore(scoreOf(currentPvpBlind, id), runnerScore) === 1,
	)
	return caught ? [runner, ...behind] : behind
}

// The Runner's ante-skip voucher gives every Hunter a life; anyone else's gives nobody.
// The ledger skips a player at 0 lives or out of the run. One gain per voucher is the
// ledger's.
const voucherGainers: NonNullable<Mode['voucherGainers']> = (run, action) =>
	run.teams[action.playerId] === 'RUNNER'
		? Object.keys(run.teams)
				.filter((id) => run.teams[id] === 'HUNTER')
				.sort()
		: []

// Only the Runner redeems the ante-skip voucher (anyone else is refused
// `not_in_run`).
const mayRedeemVoucher: NonNullable<Mode['mayRedeemVoucher']> = (
	run,
	playerId,
) => run.teams[playerId] === 'RUNNER'

// Of the two sides only a dying Runner opens a waiting death; a Hunter at 0
// is simply out.
const opensSideDeath = (run: Run, playerId: string): boolean =>
	run.teams[playerId] === 'RUNNER'

// Every Manhunt ending is decided here, in this order:
// 1. the Runner is out of the run or at 0 lives: the Hunters win;
// 2. no Hunter is in the run with lives left: the Runner wins;
// 3. the Runner's own ante is past LAST_ANTE and no PvP blind is playing (a win
//    mid-PvP blind waits for the PvP blind to end).
function checkWinner(run: Run): Ending | null {
	const runner = runnerOf(run)
	if (runner === null) return null
	if (!isAlive(run, runner)) return winEnding(run, hunterIds(run))
	if (aliveHunters(run).length === 0) return winEnding(run, [runner])
	// A Runner who has reported no ante never wins here.
	const ante = run.players[runner]?.ante ?? null
	if (ante !== null && ante > LAST_ANTE && run.currentPvpBlind === null)
		return winEnding(run, [runner])
	return null
}

// Every Hunter targets the Runner; the Runner targets the first Hunter in the run by id.
function view(run: Run): TargetsShown {
	const runner = runnerOf(run)
	if (runner === null) return { opponents: {} }
	const opponents: { [id: string]: string | null } = {}
	for (const id of hunterIds(run)) opponents[id] = runner
	opponents[runner] = aliveHunters(run)[0] ?? null
	return { opponents }
}

// A Runner's card reaches every Hunter; a Hunter's the Runner only.
function pickOpponents(
	run: Run,
	actor: PlayerId,
	shown: TargetsShown,
): Opponents {
	const one = shown.opponents[actor] ?? null
	if (run.teams[actor] === 'RUNNER') return { one, each: hunterIds(run) }
	return { one, each: one === null ? [] : [one] }
}

export const manhuntMode: Mode = {
	name: 'manhunt',
	pickableTeams: ['RUNNER', 'HUNTER'],
	// The Runner's death waits on the Hunters as a whole.
	deathWaitsOn: 'side',
	opensSideDeath,
	pairs: 'none',
	init,
	losersOf,
	voucherGainers,
	mayRedeemVoucher,
	checkWinner,
	view,
	pickOpponents,
}
