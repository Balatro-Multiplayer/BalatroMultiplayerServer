import { compareBlindScore } from '../core/score'
// The Nemesis rules for a game that started with 3 or more players (two players
// play the duel): every ante the alive players are paired once,
// each pair plays its own PvP blind, and the match ends at one player alive.
//
// It shares the roster and the winner check (modes/common.ts);
// only the pairing, the per-pair resolution and the targets view are its own. A
// mode only names the losers.
import type { PlayerId, PvpBlind, Run } from '../core/types'
import { anteOfBlind } from '../rules/settings'
import {
	aliveIds,
	aliveInPvpBlind,
	allOutOfHands,
	highestAnte,
	lastStandingBase,
	latestPairing,
	pairingOfAnte,
	scoreOf,
} from './common'
import type { Mode, PvpPairing, TargetsShown } from './types'

const pairKey = (first: string, second: string): string =>
	first < second ? `${first}|${second}` : `${second}|${first}`

// The draw is the only source of order: Fisher-Yates.
export function shuffled(ids: string[], random: () => number): string[] {
	const out = [...ids]
	for (let index = out.length - 1; index >= 1; index--) {
		const swapIndex = Math.floor(random() * (index + 1))
		const keep = out[index]
		out[index] = out[swapIndex]
		out[swapIndex] = keep
	}
	return out
}

// The circle method: fix the first id, rotate the rest by
// `offset`, then pair (1,2), (3,4), ... `ids` has an even length. The rotations
// are distinct but not disjoint from n >= 6 (with 6 ids offsets 0 and 2 both hold
// (e,f)), so the used pairs can reset before every pair has met.
export function pairsForAnte(
	ids: string[],
	offset: number,
): [string, string][] {
	const playerCount = ids.length
	const rotated = [ids[0]]
	for (let index = 1; index < playerCount; index++)
		rotated.push(ids[((index - 1 + offset) % (playerCount - 1)) + 1])
	const pairs: [string, string][] = []
	for (let index = 0; index < playerCount; index += 2)
		pairs.push([rotated[index], rotated[index + 1]])
	return pairs
}

// The first rotation whose pairs are all unused; none when every rotation
// repeats a pair.
function freshPvpBlind(
	ids: string[],
	used: Set<string>,
): [string, string][] | null {
	for (let offset = 0; offset <= ids.length - 2; offset++) {
		const pairs = pairsForAnte(ids, offset)
		if (pairs.every(([first, second]) => !used.has(pairKey(first, second))))
			return pairs
	}
	return null
}

// The pairing of one ante from the players alive now. Shuffle; an odd count
// gives the first shuffled id that did not bye last ante the bye; take the first
// rotation with no pair played before, or start the used pairs over
// when every rotation repeats one. Pure: `random` is the only input besides the
// arguments.
export function pairNemesis(
	alive: string[],
	previous: PvpPairing | null,
	ante: number,
	random: () => number,
): PvpPairing {
	const used = previous?.usedPairs ?? []
	const lastBye = previous?.lastBye ?? null
	if (alive.length < 2) return { ante, partners: {}, usedPairs: used, lastBye }

	const ids = shuffled([...alive].sort(), random)
	let bye: string | null = null
	if (ids.length % 2 === 1) {
		const at = Math.max(
			0,
			ids.findIndex((id) => id !== lastBye),
		)
		bye = ids.splice(at, 1)[0]
	}

	const fresh = freshPvpBlind(ids, new Set(used))
	const chosen = fresh ?? pairsForAnte(ids, 0)
	const partners: { [id: string]: string | null } = {}
	if (bye !== null) partners[bye] = null
	for (const [first, second] of chosen) {
		partners[first] = second
		partners[second] = first
	}
	return {
		ante,
		partners,
		usedPairs: [
			...(fresh ? used : []),
			...chosen.map(([first, second]) => pairKey(first, second)),
		],
		lastBye: bye,
	}
}

// The alive players are paired once per ante, the first time the ante rises
// (ante 1 before the first PvP blind opens). A second call at the same ante
// changes nothing.
function onAnte(run: Run, random: () => number): Run {
	const ante = highestAnte(run)
	// No ante reported yet: nothing to pair for.
	if (ante === null) return run
	const previous = latestPairing(run)
	if (previous !== null && ante <= previous.ante) return run
	const made = pairNemesis(aliveIds(run), previous, ante, random)
	return { ...run, pairings: { ...run.pairings, [made.ante]: made } }
}

// Once every alive player is out of hands, each stored pair whose two
// players are both alive loses its lower score (an exact tie loses nobody). A
// player whose partner is dead, gone or the bye loses nothing.
function nemesisLosers(run: Run, currentPvpBlind: PvpBlind): PlayerId[] | null {
	const alive = aliveInPvpBlind(run, currentPvpBlind)
	if (alive.length < 2 || !allOutOfHands(currentPvpBlind, alive)) return null
	const partners =
		pairingOfAnte(run, anteOfBlind(currentPvpBlind.blindKey))?.partners ?? {}
	const losers: string[] = []
	for (const id of alive) {
		const partner = partners[id] ?? null
		// each pair once, from its lower id
		if (partner === null || id > partner || !alive.includes(partner)) continue
		const order = compareBlindScore(
			scoreOf(currentPvpBlind, id),
			scoreOf(currentPvpBlind, partner),
		)
		if (order === -1) losers.push(id)
		else if (order === 1) losers.push(partner)
	}
	return losers.sort()
}

// The stored partner of each alive player (null for the bye or with no pairing).
function view(run: Run, ante: number | null): TargetsShown {
	const pairing = pairingOfAnte(run, ante)
	const opponents: { [id: string]: string | null } = {}
	for (const id of aliveIds(run)) opponents[id] = pairing?.partners[id] ?? null
	return { opponents, pairingAnte: pairing?.ante ?? null }
}

export const nemesisMode: Mode = {
	name: 'nemesis',
	// A game of 3 or more players: every death waits on all the others.
	deathWaitsOn: 'everyone',
	...lastStandingBase,
	pairs: 'by ante',
	losersOf: nemesisLosers,
	onAnte,
	view,
}
