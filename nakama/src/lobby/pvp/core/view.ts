// The one view each player is shown. It only puts parts together: a part with a hiding rule
// is built by the module that owns the rule (pvpBlindView, timersView, visibleInbox,
// targetsOf); a plain copy of state is built here. `stage` and `status` are worked out for
// every view and stored nowhere. A pure read: it changes nothing and reads no clock.
import { pvpBlindView } from '../inputs/pvp_blind'
import { runPlayerView } from '../inputs/run'
import { timersView } from '../inputs/timer'
import { targetsOf } from '../rules/opponent_targets'
import { isStanding } from '../rules/players'
import { visibleInbox } from './inbox'
import type {
	Deadline,
	MatchResult,
	MatchResultView,
	MatchView,
	Milliseconds,
	MyView,
	PlayerId,
	PlayerView,
	Run,
	RunView,
	State,
} from './types'

// What the lobby knows and this core does not.
export interface ViewFacts {
	// A game has started (the Setup is open or done); false while the lobby only waits.
	gameStarted: boolean
	// Players whose connection is away now, and players who have left the lobby.
	away: PlayerId[]
	left: PlayerId[]
	// The lobby's grace countdown for away players, null when none runs.
	grace: { against: PlayerId[]; endsAt: Milliseconds } | null
	// The newest input number taken from each player; one not listed = 0.
	messageNumbers: { [player: PlayerId]: number }
}

function stageOf(state: State, facts: ViewFacts): MatchView['stage'] {
	if (state.result !== null) return 'ended'
	if (state.run !== null) return 'run'
	return facts.gameStarted ? 'setup' : 'lobby'
}

// Left, then away, then out, else playing. A player whose last life is lost on a normal
// blind has a waiting death and is not out yet.
function statusOf(
	state: State,
	player: PlayerId,
	facts: ViewFacts,
): PlayerView['status'] {
	if (facts.left.includes(player)) return 'left'
	if (facts.away.includes(player)) return 'away'
	const run = state.run
	if (run === null) return 'playing'
	const waiting = run.waitingDeaths.some((death) => death.playerId === player)
	return isStanding(run.lives[player]) || waiting ? 'playing' : 'out'
}

// The game reads `rated` as a boolean; every other kind goes out as it is.
export function resultView(result: MatchResult | null): MatchResultView | null {
	if (result === null) return null
	switch (result.kind) {
		case 'win':
			return {
				kind: 'win',
				winners: result.winners,
				rated: result.rating === 'rated',
			}
		case 'draw':
			return { kind: 'draw', rated: result.rating === 'rated' }
		case 'agreed':
		case 'abandoned':
		case 'contested':
		case 'restarted':
			return result
		default: {
			const unhandled: never = result
			return unhandled
		}
	}
}

function runViewOf(state: State, run: Run, viewer: PlayerId): RunView {
	const players: RunView['players'] = {}
	for (const player of Object.keys(run.players))
		players[player] = runPlayerView(run, player)
	return {
		id: run.id,
		rules: run.rules,
		players,
		currentPvpBlind: pvpBlindView(state, viewer),
		finishedPvpBlinds: run.finishedPvpBlinds,
		targets: targetsOf(state, viewer),
		waitingDeaths: run.waitingDeaths.map((death) => ({
			player: death.playerId,
			blindKey: death.blindKey,
			waitingFor: death.waitingFor,
		})),
		teamLives: run.teamLives,
		votes: run.votes,
	}
}

// What every player of the match shows. Another player's end screen comes only once the
// match has ended; my own is never sent back. Their newest jokers come to a viewer who
// is out as well, from their endGame once it has jokers, else from their last shop exit.
function playersViewOf(
	state: State,
	viewer: PlayerId,
	facts: ViewFacts,
): MyView['players'] {
	const run = state.run
	const players: MyView['players'] = {}
	const viewerStatus = statusOf(state, viewer, facts)
	const viewerDone =
		state.result !== null || viewerStatus === 'out' || viewerStatus === 'left'
	for (const player of Object.keys(state.players)) {
		const endGame = run?.endGames[player]
		const showEndGame =
			state.result !== null && player !== viewer && endGame !== undefined
		// The newest jokers known: the end game's once it came with jokers, else the last shop exit's.
		// A run checkpointed before lastJokers existed has none.
		const lastJokers =
			endGame !== undefined && endGame.jokers !== ''
				? endGame.jokers
				: run?.lastJokers?.[player]
		const showJokers =
			viewerDone &&
			player !== viewer &&
			lastJokers !== undefined &&
			!showEndGame
		players[player] = {
			team:
				run === null ? state.players[player].team : (run.teams[player] ?? null),
			status: statusOf(state, player, facts),
			...(run !== null && player in run.places
				? { place: run.places[player] }
				: {}),
			...(showEndGame ? { endGame } : {}),
			...(showJokers ? { jokers: lastJokers } : {}),
		}
	}
	return players
}

// A player who is not in the match has no view.
export function view(
	state: State,
	player: PlayerId,
	now: Milliseconds,
	facts: ViewFacts,
): MyView | null {
	const own = state.players[player]
	if (own === undefined) return null
	const timers = timersView(state, player, now)
	const grace: Deadline[] =
		facts.grace === null
			? []
			: [
					{
						kind: 'grace',
						by: null,
						against: facts.grace.against,
						endsAt: facts.grace.endsAt,
						pausedAt: null,
						hold: 'counting',
					},
				]
	return {
		serverTime: now,
		lastMessageReceived: facts.messageNumbers[player] ?? 0,
		me: player,
		match: {
			stage: stageOf(state, facts),
			result: resultView(state.result),
			run: state.run === null ? null : runViewOf(state, state.run, player),
		},
		players: playersViewOf(state, player, facts),
		timers: { ...timers, deadlines: [...timers.deadlines, ...grace] },
		onlyMine: {
			...visibleInbox(state, player),
		},
	}
}
