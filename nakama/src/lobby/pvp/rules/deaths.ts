// The waiting death: a player who loses their last life on a normal blind is not out yet.
// The result waits until the players the mode names have answered the same blind, because
// they may fail it too. Pure: `openWaitingDeath` is called by the life ledger (lives.ts);
// `settleDeaths` closes them and says how the game ends, if it does.
// The glue that writes the result is `settleWaitingDeaths` (inputs/finish.ts).
import { type Ending, drawEnding, winEnding } from '../core/ending'
import { same } from '../core/same'
import type {
	BlindKey,
	BlindResult,
	PlayerId,
	Run,
	RunExit,
} from '../core/types'
import type { Mode, WaitingDeath } from '../modes/types'
import { isPvpBlindOf, isStanding } from './players'
import { isBlindKey } from './settings'

// How a player answered a blind: their own blind result, or for a Boss blind they played as
// a PvP blind, the PvP blind's result once it is over (a player on a bye waits for it).
function answerOf(
	run: Run,
	player: PlayerId,
	blindKey: BlindKey,
): { result: BlindResult } | undefined {
	const own = run.players[player]?.results[blindKey]
	if (own !== undefined) return own
	const played = run.finishedPvpBlinds.find(
		(done) => done.blindKey === blindKey && player in done.scores,
	)
	return played === undefined
		? undefined
		: { result: played.losers.includes(player) ? 'lost' : 'beaten' }
}

// A blind that was beaten, or skipped (a skip is no failure).
const passed = (answer: { result: BlindResult } | undefined): boolean =>
	answer?.result === 'beaten' || answer?.result === 'skipped'

const standingIds = (run: Run): PlayerId[] =>
	Object.keys(run.lives)
		.sort()
		.filter((id) => isStanding(run.lives[id]))

// ---- opening ----

// Who a death on `blindKey` waits for, by the mode's rule. Where the death waits on a side,
// players that already answered that blind are not waited on; settling trims the rest.
function waitingForDeath(
	run: Run,
	mode: Mode,
	dead: PlayerId,
	blindKey: BlindKey,
): PlayerId[] {
	const others = Object.keys(run.lives)
		.sort()
		.filter((id) => id !== dead)
	if (mode.deathWaitsOn === 'opponent') return others
	if (mode.deathWaitsOn === 'everyone') return others
	const teams = run.teams
	const side = teams[dead]
	return others.filter(
		(id) =>
			teams[id] !== undefined &&
			teams[id] !== side &&
			isStanding(run.lives[id]) &&
			answerOf(run, id, blindKey) === undefined,
	)
}

// `id` lost their last life on the event `cause`: opens a waiting death when the mode's
// rule says so. `run` is the run with that loss in it.
export function openWaitingDeath(
	run: Run,
	mode: Mode,
	id: PlayerId,
	cause: string | null,
): Run {
	if (cause === null || !isBlindKey(cause) || isPvpBlindOf(run, id, cause))
		return run
	const open = run.waitingDeaths
	if (open.some((death) => death.playerId === id)) return run
	if (mode.deathWaitsOn === 'side') {
		if (open.length > 0) return run
		if (mode.opensSideDeath?.(run, id) === false) return run
	}
	const death: WaitingDeath = {
		playerId: id,
		blindKey: cause,
		waitingFor: waitingForDeath(run, mode, id, cause),
	}
	return { ...run, waitingDeaths: [...open, death] }
}

// ---- the way out of the standing ----

// The exits a change of the lives made: every player standing before and not after. They
// all go out together, so they share one batch.
export function recordExits(run: Run, after: Run['lives']): RunExit[] {
	const exited = Object.keys(after)
		.sort()
		.filter((id) => isStanding(run.lives[id]) && !isStanding(after[id]))
	if (exited.length === 0) return run.exits
	const batch = (run.exits[run.exits.length - 1]?.batch ?? 0) + 1
	return [
		...run.exits,
		...exited.map((player) => {
			const events = after[player].events
			const last = events[events.length - 1]
			const lostLastLife = after[player].lives <= 0 && last?.delta === -1
			return {
				player,
				blindKey:
					lostLastLife && last.cause !== null && isBlindKey(last.cause)
						? last.cause
						: null,
				batch,
			}
		}),
	]
}

// ---- settling ----

const sameList = (left: PlayerId[], right: PlayerId[]): boolean =>
	left.length === right.length && left.every((id, at) => id === right[at])

// Players share a place only when they went out together (the same batch), or on the same
// blind with nobody going out between them. A player not standing with no exit on record
// went out before all of them. Later exits rank higher; the next place after a shared one
// is skipped.
function exitPlaces(run: Run): Run['places'] {
	const survivors = standingIds(run)
	const recorded = new Set(run.exits.map((exit) => exit.player))
	const lost = Object.keys(run.lives)
		.sort()
		.filter((id) => !survivors.includes(id) && !recorded.has(id))
	const groups: PlayerId[][] = lost.length > 0 ? [lost] : []
	let previous: RunExit | null = null
	for (const exit of run.exits) {
		if (survivors.includes(exit.player)) continue
		const together =
			previous !== null &&
			(previous.batch === exit.batch ||
				(exit.blindKey !== null && previous.blindKey === exit.blindKey))
		if (together) groups[groups.length - 1].push(exit.player)
		else groups.push([exit.player])
		previous = exit
	}
	const places: Run['places'] = {}
	for (const id of survivors) places[id] = 1
	let better = survivors.length
	for (let at = groups.length - 1; at >= 0; at--) {
		for (const id of groups[at]) places[id] = better + 1
		better += groups[at].length
	}
	return places
}

type Verdict = { kept: WaitingDeath } | { ended: Ending } | null

// A duel: the opponent's answer, in this order: they beat the blind (they win), they are
// out of lives too (a draw), they failed it (they win), they left (the dead player wins).
function settleOpponent(run: Run, death: WaitingDeath): Verdict {
	const opponent = death.waitingFor[0]
	if (opponent === undefined) return null
	const seat = run.lives[opponent]
	if (seat === undefined) return { kept: death }
	const answer = answerOf(run, opponent, death.blindKey)
	if (passed(answer)) return { ended: winEnding(run, [opponent]) }
	if (seat.lives <= 0) return { ended: drawEnding(run) }
	if (answer !== undefined) return { ended: winEnding(run, [opponent]) }
	if (seat.status === 'forfeited' || seat.status === 'left')
		return { ended: winEnding(run, [death.playerId]) }
	return { kept: death }
}

// Everyone else standing: the death is over once each has answered, or gone.
function settleEveryone(run: Run, death: WaitingDeath): Verdict {
	const waitingFor = standingIds(run).filter(
		(id) =>
			id !== death.playerId && answerOf(run, id, death.blindKey) === undefined,
	)
	if (waitingFor.length === 0) return null
	return {
		kept: sameList(waitingFor, death.waitingFor)
			? death
			: { ...death, waitingFor },
	}
}

// The other side: any member that beat the blind wins it for their side. Otherwise the
// death waits for the members still in the run. Once none is left to answer, a draw needs
// at least one member to have answered and failed; if the whole side is gone without
// answering, the dead side wins, as in a duel.
function settleSide(run: Run, death: WaitingDeath): Verdict {
	const teams = run.teams
	const side = teams[death.playerId]
	const theirs = Object.keys(run.lives)
		.sort()
		.filter((id) => teams[id] !== undefined && teams[id] !== side)
	if (theirs.some((id) => passed(answerOf(run, id, death.blindKey))))
		return { ended: winEnding(run, theirs) }
	const waitingFor = theirs.filter(
		(id) =>
			isStanding(run.lives[id]) &&
			answerOf(run, id, death.blindKey) === undefined,
	)
	if (waitingFor.length === 0)
		return theirs.some((id) => answerOf(run, id, death.blindKey) !== undefined)
			? { ended: drawEnding(run) }
			: {
					ended: winEnding(
						run,
						Object.keys(run.lives).filter((id) => teams[id] === side),
					),
				}
	return {
		kept: sameList(waitingFor, death.waitingFor)
			? death
			: { ...death, waitingFor },
	}
}

// Closes the waiting deaths that have their answers. Returns the same run when nothing
// changed. In a game where deaths wait on everyone, the game ends once at most one player
// stands and no death waits; its places come from the exits.
export function settleDeaths(
	run: Run,
	mode: Mode,
): { run: Run; ending: Ending | null } {
	const kept: WaitingDeath[] = []
	let ending: Ending | null = null
	for (const death of run.waitingDeaths) {
		const verdict =
			mode.deathWaitsOn === 'opponent'
				? settleOpponent(run, death)
				: mode.deathWaitsOn === 'side'
					? settleSide(run, death)
					: settleEveryone(run, death)
		if (verdict === null) continue
		if ('ended' in verdict) ending ??= verdict.ended
		else kept.push(verdict.kept)
	}
	const unchanged =
		kept.length === run.waitingDeaths.length &&
		kept.every((death, at) => same(death, run.waitingDeaths[at]))
	const settled: Run = unchanged ? run : { ...run, waitingDeaths: kept }
	if (ending !== null) return { run: settled, ending }
	if (
		mode.deathWaitsOn === 'everyone' &&
		kept.length === 0 &&
		run.exits.length > 0 &&
		standingIds(run).length <= 1
	) {
		const places = exitPlaces(run)
		const winners = Object.keys(places).filter((id) => places[id] === 1)
		return {
			run: settled,
			ending: { winners: winners.length === 1 ? winners : null, places },
		}
	}
	return { run: settled, ending: null }
}
