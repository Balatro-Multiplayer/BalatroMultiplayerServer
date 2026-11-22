// How a match ends: the votes, a forfeit, what a finished player sends, and the one writer
// of `state.result`. Every ending reaches the result through `setResult`; the first one
// stays, so a later leave or a late PvP blind never rewrites it. A run's ending is decided in
// `decideMatch` and nowhere else; the shell calls it after every input and every tick.
import type { Handled, InputHandler } from '../core/apply'
import type {
	EndGame,
	MatchResult,
	Milliseconds,
	PlayerId,
	Rating,
	State,
} from '../core/types'
import { settleDeaths } from '../rules/deaths'
import { applyAction, changeLedger, markLeft } from '../rules/lives'
import { isInRun } from '../rules/players'
import { modeOf } from '../modes/index'
import { settlePvpBlind } from './pvp_blind'

// The most characters one endGame text field may hold (UTF-16 units, as isTextUpTo
// counts them): the ended view carries seven endGames.
export const END_GAME_TEXT_MAX = 6000

// The most characters the jokers text of one shop exit may hold; a view can carry seven of them
// next to the seven end games.
export const JOKERS_TEXT_MAX = 1500

const COUNT_MAX = 1_000_000

export type FinishInput =
	| { kind: 'vote'; topic: 'draw' | 'seed'; yes: boolean }
	| { kind: 'forfeit' }
	| { kind: 'jokers'; jokers: string }
	| { kind: 'endGame'; jokers: string; deck: string; stats: EndGame['stats'] }

const voteSpec = {
	topic: { type: 'oneOf', values: ['draw', 'seed'] },
	yes: { type: 'flag' },
} as const
const forfeitSpec = {} as const
const jokersSpec = {
	jokers: { type: 'text', max: JOKERS_TEXT_MAX, mayBeEmpty: true },
} as const
const endGameSpec = {
	jokers: { type: 'text', max: END_GAME_TEXT_MAX, mayBeEmpty: true },
	deck: { type: 'text', max: END_GAME_TEXT_MAX, mayBeEmpty: true },
	stats: {
		type: 'object',
		fields: {
			rerollCount: { type: 'whole', max: COUNT_MAX },
			rerollCostTotal: { type: 'whole', max: COUNT_MAX },
		},
	},
} as const

// ---- the results, one maker each ----

const ratingOf = (ranked: boolean): Rating => (ranked ? 'rated' : 'unrated')

export const winResult = (
	winners: PlayerId[],
	ranked: boolean,
): MatchResult => ({
	kind: 'win',
	winners: [...winners].sort(),
	rating: ratingOf(ranked),
})
export const drawResult = (ranked: boolean): MatchResult => ({
	kind: 'draw',
	rating: ratingOf(ranked),
})
export const agreedResult = (): MatchResult => ({ kind: 'agreed' })
export const abandonedResult = (): MatchResult => ({ kind: 'abandoned' })
export const restartedResult = (): MatchResult => ({ kind: 'restarted' })

// The only writer of `state.result`: the first ending stays.
export function setResult(state: State, result: MatchResult): State {
	return state.result === null ? { ...state, result } : state
}

// ---- who is still in the run ----

const goneFromRun = (state: State, player: PlayerId): boolean => {
	const seat = state.run?.lives[player]
	return (
		seat === undefined || seat.status === 'forfeited' || seat.status === 'left'
	)
}

const everyoneGone = (state: State): boolean =>
	state.run !== null &&
	Object.keys(state.run.lives).every((player) => goneFromRun(state, player))

// ---- the run's ending ----

// The one place a run ends, and the one place a waiting death holds it: nothing is decided
// while any death waits. In this order: a winner the mode has decided; nobody left in
// the run (abandoned, only when nobody won); a draw the mode has decided; a draw vote or a
// new-seed vote, each passing only while at least 2 players are still in the run. A draw
// by vote is as rated as the lobby is.
export function decideMatch(state: State, ranked: boolean): State {
	const run = state.run
	if (run === null || state.result !== null) return state
	if (run.waitingDeaths.length > 0) return state
	const ending = modeOf(run).checkWinner(run)
	const withPlaces: State =
		ending === null
			? state
			: { ...state, run: { ...run, places: ending.places } }
	if (ending !== null && ending.winners !== null)
		return setResult(withPlaces, winResult(ending.winners, ranked))
	if (everyoneGone(state)) return setResult(state, abandonedResult())
	if (ending !== null) return setResult(withPlaces, drawResult(ranked))
	const players = Object.keys(run.lives).filter((player) =>
		isInRun(run, player),
	)
	if (players.length < 2) return state
	if (players.every((player) => run.votes.draw.includes(player)))
		return setResult(state, drawResult(ranked))
	if (players.every((player) => run.votes.seed.includes(player)))
		return setResult(state, restartedResult())
	return state
}

// Closes the waiting deaths that have their answers (rules/deaths.ts) and, when that ends
// the game, writes its places and result. Runs before `decideMatch`, which a death that
// still waits holds.
export function settleWaitingDeaths(state: State, ranked: boolean): State {
	const run = state.run
	if (run === null || state.result !== null) return state
	const settled = settleDeaths(run, modeOf(run))
	if (settled.ending === null)
		return settled.run === run ? state : { ...state, run: settled.run }
	const { winners, places } = settled.ending
	return setResult(
		{ ...state, run: { ...settled.run, places } },
		winners === null ? drawResult(ranked) : winResult(winners, ranked),
	)
}

// ---- leaving ----

// A player leaves before the run begins. A ranked match ends with no result (abandoned,
// nobody is rated); any other leave ends the match as agreed.
export function leaveBeforeRun(
	state: State,
	leavers: PlayerId[],
	ranked: boolean,
): State {
	if (state.run !== null || leavers.length === 0) return state
	return setResult(state, ranked ? abandonedResult() : agreedResult())
}

// A player forfeits, or has left the lobby mid-run: they are out of the run and the PvP blind
// that waited on them can resolve. The ending is `decideMatch`'s.
export function dropPlayer(
	state: State,
	player: PlayerId,
	how: 'forfeit' | 'left',
	now: Milliseconds,
): State {
	const run = state.run
	if (run === null || state.result !== null || goneFromRun(state, player))
		return state
	const changed = changeLedger(state, (before) =>
		how === 'forfeit'
			? applyAction(
					before,
					{ type: 'forfeit', playerId: player },
					modeOf(before),
				)
			: markLeft(before, player),
	)
	return settlePvpBlind(changed, now)
}

// ---- the inputs ----

export const voteHandler: InputHandler<typeof voteSpec> = {
	spec: voteSpec,
	handle(state, player, body): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		if (!isInRun(run, player)) return { refusal: 'eliminated' }
		const others = run.votes[body.topic].filter((id) => id !== player)
		const voted = body.yes ? [...others, player].sort() : others
		return {
			...state,
			run: { ...run, votes: { ...run.votes, [body.topic]: voted } },
		}
	},
}

export const forfeitHandler: InputHandler<typeof forfeitSpec> = {
	spec: forfeitSpec,
	handle(state, player, _body, now): Handled {
		if (state.run === null) return { refusal: 'no_run' }
		if (!isInRun(state.run, player)) return { refusal: 'already_out' }
		return dropPlayer(state, player, 'forfeit', now)
	},
}

// The jokers a player holds on leaving a shop: the newest wins, and the end screen shows them for
// a player whose endGame has not come (they are still playing, or gone).
export const jokersHandler: InputHandler<typeof jokersSpec> = {
	spec: jokersSpec,
	handle(state, player, body): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		return {
			...state,
			run: { ...run, lastJokers: { ...run.lastJokers, [player]: body.jokers } },
		}
	},
}

// What a player sends when done: allowed once they are out of the run, or the match is
// decided; the newest wins.
export const endGameHandler: InputHandler<typeof endGameSpec> = {
	spec: endGameSpec,
	handle(state, player, body): Handled {
		const run = state.run
		if (run === null) return { refusal: 'no_run' }
		if (state.result === null && isInRun(run, player))
			return { refusal: 'still_playing' }
		return {
			...state,
			run: { ...run, endGames: { ...run.endGames, [player]: body } },
		}
	},
}
