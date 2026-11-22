import { compareBlindScore } from '../core/score'
// The Royale: a game that started with 3+ players. The roster and the win check are the
// shared ones (modes/common.ts); this file adds the rank-and-cut PvP blind resolution and the
// live target + cut marker. Every rule is pure; a mode only names the losers.
import type { PlayerId, PvpBlind, Run, Targets } from '../core/types'
import {
	aliveIds,
	aliveInPvpBlind,
	allOutOfHands,
	lastStandingBase,
	scoreOf,
} from './common'
import type { Mode, TargetsShown } from './types'

// `score` is null for a player who has reported none; it ranks below every score.
interface RoyaleEntry {
	id: string
	score: string | null
}

const greater = (first: string | null, second: string | null): boolean =>
	compareBlindScore(first, second) === 1

// Ascending by score, ties by id so the answer never depends on input order.
function byScore(players: RoyaleEntry[]): RoyaleEntry[] {
	return [...players].sort(
		(first, second) =>
			compareBlindScore(first.score, second.score) ||
			(first.id < second.id ? -1 : 1),
	)
}

// The cut sits at the player floor(N/2) (min 1) from the bottom, and everyone
// who does not beat that score is cut, so a tie at the cut never splits. When the
// cut score is the top score, the cut moves to just under the top: everyone
// strictly below the top is cut.
function cut(ranked: RoyaleEntry[]): Set<string> {
	if (ranked.length === 0) return new Set()
	const top = ranked[ranked.length - 1].score
	let cutoff = ranked[Math.max(1, Math.floor(ranked.length / 2)) - 1].score
	if (!greater(top, cutoff)) {
		const below = ranked.filter((entry) => greater(top, entry.score)).pop()
		if (below) cutoff = below.score
	}
	return new Set(
		ranked
			.filter((entry) => !greater(entry.score, cutoff))
			.map((entry) => entry.id),
	)
}

// The ranking of the alive players and who loses a life. When every player is
// cut (all tied) nobody loses.
export function rankRoyale(players: RoyaleEntry[]): {
	ranked: string[]
	losers: string[]
} {
	const ranked = byScore(players)
	const cutIds = cut(ranked)
	const all = cutIds.size === ranked.length
	return {
		ranked: ranked.map((entry) => entry.id),
		losers: all
			? []
			: ranked.map((entry) => entry.id).filter((id) => cutIds.has(id)),
	}
}

// The PvP blind resolves once, when EVERY alive player has no hands left.
// Players who are dead, forfeited or left are never ranked and never waited for.
// At two alive the cut leaves the lower score losing, and a tie costs nobody.
function royaleLosers(run: Run, currentPvpBlind: PvpBlind): PlayerId[] | null {
	const alive = aliveInPvpBlind(run, currentPvpBlind)
	if (alive.length < 2 || !allOutOfHands(currentPvpBlind, alive)) return null
	return rankRoyale(
		alive.map((id) => ({ id, score: scoreOf(currentPvpBlind, id) })),
	).losers
}

// The target is the next player by id, and nobody is above the cut: no score is shown here, so
// every player counts as losing (the cut with everyone tied).
function view(run: Run): TargetsShown {
	const ranked = aliveIds(run)
	if (ranked.length < 2) return { opponents: {}, cut: {} }
	const opponents: { [id: string]: string | null } = {}
	const cut: { [id: string]: Targets['cut'] } = {}
	ranked.forEach((id, place) => {
		opponents[id] = ranked[place + 1] ?? null
		cut[id] = 'below the cut'
	})
	return { opponents, cut }
}

export const royaleMode: Mode = {
	name: 'royale',
	// A game of 3 or more players: every death waits on all the others.
	deathWaitsOn: 'everyone',
	...lastStandingBase,
	losersOf: royaleLosers,
	view,
}
