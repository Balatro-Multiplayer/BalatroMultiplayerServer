// Who plays whom, and who a card of a player hits. The pairing and the card targets are
// stored by the modes (`run.pairings`, `run.cardTargets`); everything here is read from them
// and from the players' reported antes, nothing is frozen a second time.
import { seededRandom } from '../core/random'
import type {
	MyBoss,
	PlayerId,
	PvpBlind,
	Run,
	State,
	Targets,
} from '../core/types'
import { highestAnte, inRunWithLives } from '../modes/common'
import type { Mode, Opponents, TargetsShown } from '../modes/types'
import { isInRun, isPvpBlind, playersOfBoss } from './players'
import { modeOf } from '../modes/index'
import { mayLookAtScores } from './pvp_blind_rules'
import { anteOfBlind } from './settings'

const unique = (ids: PlayerId[]): PlayerId[] => [...new Set(ids)]

// The mode's ante rule, run when a player reports a higher ante. The draw is seeded by the
// run and the ante, so the same state always pairs the same way.
export function pairForNewAnte(state: State): State {
	const run = state.run
	if (run === null) return state
	const ante = highestAnte(run)
	const next = modeOf(run).onAnte?.(run, seededRandom(`${run.id}:${ante}`))
	return next === undefined || next === run ? state : { ...state, run: next }
}

// Never the player, never someone out of the run, never a teammate.
function mayTarget(run: Run, actor: PlayerId, id: PlayerId): boolean {
	if (id === actor || !inRunWithLives(run.lives[id])) return false
	const mine = run.teams[actor]
	return mine === undefined || run.teams[id] !== mine
}

function opponentsFrom(
	run: Run,
	mode: Mode,
	shown: TargetsShown,
	actor: PlayerId,
): Opponents {
	const picked = mode.pickOpponents(run, actor, shown)
	return {
		each: unique(picked.each).filter((id) => mayTarget(run, actor, id)),
		one:
			picked.one !== null && mayTarget(run, actor, picked.one)
				? picked.one
				: null,
	}
}

// What the mode shows at `ante`. No run yet has nobody.
function shownTargets(
	state: State,
	ante: number | null,
): { run: Run; mode: Mode; shown: TargetsShown } | null {
	const run = state.run
	if (run === null) return null
	const mode = modeOf(run)
	return { run, mode, shown: mode.view(run, ante) }
}

// What the mode shows for `player`: the ante they reported, none while they have reported none.
function shownTargetsOf(state: State, player: PlayerId) {
	return shownTargets(state, state.run?.players[player]?.ante ?? null)
}

// What the server does about the Boss on the ante `viewer` reported: 'plays' when they are in
// its PvP blind, 'bye' when they are in it but nobody is paired with them (Nemesis), and 'no pvp
// this ante' when there is no such PvP blind or they are not in it.
export function myBossOf(state: State, viewer: PlayerId): MyBoss {
	const run = state.run
	const ante = run?.players[viewer]?.ante ?? null
	if (run === null || ante === null) return 'no pvp this ante'
	const blindKey = `${ante}:Boss`
	if (!isPvpBlind(run, blindKey)) return 'no pvp this ante'
	const resolved = run.finishedPvpBlinds.find(
		(done) => done.blindKey === blindKey,
	)
	const inPvpBlind =
		run.currentPvpBlind?.blindKey === blindKey
			? run.currentPvpBlind.players[viewer] !== undefined
			: resolved !== undefined
				? viewer in resolved.scores
				: playersOfBoss(run, blindKey).includes(viewer)
	if (!inPvpBlind) return 'no pvp this ante'
	if (modeOf(run).pairs !== 'by ante' || run.pairings[ante] === undefined)
		return 'plays'
	return opponentsOf(state, viewer).one === null ? 'bye' : 'plays'
}

export function opponentsOf(state: State, actor: PlayerId): Opponents {
	const shown = shownTargetsOf(state, actor)
	return shown === null
		? { each: [], one: null }
		: opponentsFrom(shown.run, shown.mode, shown.shown, actor)
}

// The opponent of `actor` in the pairing of the PvP blind's own ante. Null when there is none.
export function pvpBlindOpponentOf(
	state: State,
	currentPvpBlind: PvpBlind,
	actor: PlayerId,
): PlayerId | null {
	const run = state.run
	if (run === null) return null
	const shown = shownTargets(state, anteOfBlind(currentPvpBlind.blindKey))
	return shown === null
		? null
		: opponentsFrom(shown.run, shown.mode, shown.shown, actor).one
}

// The team sums of the PvP blind being played, from the scores the players reported. Hidden
// from a viewer who may not look at scores yet; null too while no PvP blind plays or a team has
// no score.
function teamScoresOf(
	viewer: PlayerId,
	shown: { run: Run; mode: Mode },
): Targets['teamScores'] {
	const currentPvpBlind = shown.run.currentPvpBlind
	if (currentPvpBlind === null || !mayLookAtScores(currentPvpBlind, viewer))
		return null
	const sums = shown.mode.teamScores?.(shown.run, currentPvpBlind)
	return sums?.A != null && sums.B != null ? { A: sums.A, B: sums.B } : null
}

// What `viewer` may know of who plays whom.
export function targetsOf(state: State, viewer: PlayerId): Targets {
	const shown = shownTargetsOf(state, viewer)
	const run = state.run
	if (shown === null || run === null)
		return {
			pairingAnte: null,
			opponents: [],
			cardTargets: [],
			myBoss: myBossOf(state, viewer),
			cut: 'no cut',
			teamScores: null,
		}
	const mine = opponentsFrom(shown.run, shown.mode, shown.shown, viewer)
	return {
		pairingAnte: shown.shown.pairingAnte ?? null,
		opponents: mine.one === null ? [] : [mine.one],
		cardTargets: mine.each,
		myBoss: myBossOf(state, viewer),
		// Royale with 3 or more shows whether a player is above the cut; every other mode none.
		cut: shown.shown.cut?.[viewer] ?? 'no cut',
		teamScores: teamScoresOf(viewer, shown),
	}
}
