import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	END_GAME_TEXT_MAX,
	JOKERS_TEXT_MAX,
	abandonedResult,
	agreedResult,
	drawResult,
	restartedResult,
	winResult,
} from '../inputs/finish'
import { mayLookAtScores, scoreOf } from '../rules/pvp_blind_rules'
import { BLIND, ready, runOf, send } from '../testing/inputs'
import {
	LIMITS,
	pairedRun,
	reportedRunInMode as runInMode,
	runState,
} from '../testing/state'
import { INBOX_ITEMS_PER_VIEW } from './inbox'

import { tick } from './tick'
import type {
	EndGame,
	InboxItem,
	MatchResult,
	MyView,
	PlayerId,
	PlayerView,
	PvpBlindResult,
	State,
	Team,
} from './types'
import { utf8Bytes } from './utf8'
import { type ViewFacts, view } from './view'

const FACTS: ViewFacts = {
	gameStarted: true,
	away: [],
	left: [],
	grace: null,
	messageNumbers: {},
}
const NOW = 5_000

function viewOf(
	state: State,
	player: PlayerId,
	facts: ViewFacts = FACTS,
	now: number = NOW,
): MyView {
	const shown = view(state, player, now, facts)
	if (shown === null) throw new Error(`no view for ${player}`)
	return shown
}

const bytesOf = (shown: MyView): number =>
	Buffer.byteLength(JSON.stringify(shown), 'utf8')

const progress = (state: State, players: string[], ante: number): State =>
	players.reduce(
		(next, player) =>
			send(next, player, { kind: 'progress', ante, location: 'blind' }).state,
		state,
	)

// A duel in the PvP blind: both posted a score, neither has played a hand.
function duelMidBlind(): State {
	const players = ['ann', 'bob']
	let state = progress(
		pairedRun(players, { ann: 'bob', bob: 'ann' }),
		players,
		2,
	)
	for (const player of players) state = ready(state, player).state
	const start = (score: string) => ({
		kind: 'blindStart',
		blindKey: BLIND,
		handsLeft: 4,
		score,
	})
	state = send(state, 'ann', start('10')).state
	return send(state, 'bob', start('20')).state
}

describe('view of a duel in the PvP blind', () => {
	it("is exactly Ann's picture, with Bob's score hidden", () => {
		const state = duelMidBlind()
		expect(
			viewOf(state, 'ann', { ...FACTS, messageNumbers: { ann: 4 } }),
		).toEqual({
			serverTime: 5_000,
			lastMessageReceived: 4,
			me: 'ann',
			match: {
				stage: 'run',
				result: null,
				run: {
					id: 'run-1',
					rules: runOf(state).rules,
					players: {
						ann: {
							lives: 4,
							ante: 2,
							location: 'blind',
							skips: 0,
							sells: {},
							shopSpends: [],
						},
						bob: {
							lives: 4,
							ante: 2,
							location: 'blind',
							skips: 0,
							sells: {},
							shopSpends: [],
						},
					},
					currentPvpBlind: {
						blindKey: '2:Boss',
						stage: 'playing',
						players: {
							ann: {
								stage: 'entered',
								handsLeft: 4,
								score: { kind: 'shown', score: '10' },
							},
							bob: {
								stage: 'entered',
								handsLeft: 4,
								score: { kind: 'hidden' },
							},
						},
					},
					finishedPvpBlinds: [],
					targets: {
						pairingAnte: null,
						opponents: ['bob'],
						cardTargets: ['bob'],
						myBoss: 'plays',
						cut: 'no cut',
						teamScores: null,
					},
					waitingDeaths: [],
					teamLives: null,
					votes: { draw: [], seed: [] },
				},
			},
			players: {
				ann: { team: null, status: 'playing' },
				bob: { team: null, status: 'playing' },
			},
			timers: {
				timerButton: 'none',
				deadlines: [],
				pauses: [],
				pvpBanks: {},
				anteBanks: { ann: 150_000, bob: 150_000 },
			},
			onlyMine: { inbox: [], inboxNewest: 0 },
		})
	})

	it('shows Bob his own score, and hides the score of Ann', () => {
		const bob = viewOf(duelMidBlind(), 'bob')
		expect(bob.match.run?.currentPvpBlind?.players.bob).toMatchObject({
			score: { kind: 'shown', score: '20' },
		})
		expect(bob.match.run?.currentPvpBlind?.players.ann).toMatchObject({
			score: { kind: 'hidden' },
		})
		expect(bob.onlyMine.inbox).toEqual([])
		expect(bob.onlyMine.inboxNewest).toBe(0)
	})

	it('a player not in the match has no view', () => {
		expect(view(duelMidBlind(), 'zed', NOW, FACTS)).toBeNull()
	})
})

describe('stage', () => {
	const ended = (state: State): State => ({ ...state, result: agreedResult() })
	const lobbyState: State = { ...runState(['ann', 'bob']), run: null }

	it.each([
		['lobby: no game, no run, no result', lobbyState, false, 'lobby'],
		['setup: a game started, no run', lobbyState, true, 'setup'],
		['run: a run exists', runState(['ann', 'bob']), true, 'run'],
		[
			'run: the facts do not matter once a run exists',
			runState(['ann']),
			false,
			'run',
		],
		['ended: a result before the run', ended(lobbyState), false, 'ended'],
		[
			'ended: a result beats a run',
			ended(runState(['ann', 'bob'])),
			true,
			'ended',
		],
	] as const)('%s', (_name, state, gameStarted, stage) => {
		expect(viewOf(state, 'ann', { ...FACTS, gameStarted }).match.stage).toBe(
			stage,
		)
	})

	it('before a run: no run, empty lists, nothing of mine', () => {
		const shown = viewOf(lobbyState, 'ann', { ...FACTS, gameStarted: false })
		expect(shown.match.run).toBeNull()
		expect(shown.timers).toEqual({
			timerButton: 'none',
			deadlines: [],
			pauses: [],
			pvpBanks: {},
			anteBanks: {},
		})
		expect(shown.onlyMine).toEqual({ inbox: [], inboxNewest: 0 })
		expect(shown.players).toEqual({
			ann: { team: null, status: 'playing' },
			bob: { team: null, status: 'playing' },
		})
	})
})

describe('status of a player, in priority order', () => {
	const gone = (state: State): State => ({
		...state,
		run: {
			...runOf(state),
			lives: {
				...runOf(state).lives,
				bob: { ...runOf(state).lives.bob, lives: 0, status: 'out' },
			},
		},
	})
	const forfeited = (state: State): State => ({
		...state,
		run: {
			...runOf(state),
			lives: {
				...runOf(state).lives,
				bob: { ...runOf(state).lives.bob, status: 'forfeited' },
			},
		},
	})
	const waiting = (state: State): State => ({
		...gone(state),
		run: {
			...runOf(gone(state)),
			waitingDeaths: [
				{ playerId: 'bob', blindKey: '3:Big', waitingFor: ['ann'] },
			],
		},
	})
	const same = (state: State): State => state
	const AWAY = { ...FACTS, away: ['bob'] }
	const LEFT = { ...FACTS, left: ['bob'] }

	it.each<[string, (state: State) => State, ViewFacts, PlayerView['status']]>([
		['playing', same, FACTS, 'playing'],
		['away', same, AWAY, 'away'],
		['left', same, LEFT, 'left'],
		['out: no lives, no waiting death', gone, FACTS, 'out'],
		['out: forfeited with lives left', forfeited, FACTS, 'out'],
		['playing: no lives but a waiting death', waiting, FACTS, 'playing'],
		['away beats out', gone, AWAY, 'away'],
		['left beats out', gone, LEFT, 'left'],
		[
			'left beats away',
			same,
			{ ...FACTS, away: ['bob'], left: ['bob'] },
			'left',
		],
		['away: a waiting death does not make it playing', waiting, AWAY, 'away'],
	])('%s', (_name, change, facts, status) => {
		const shown = viewOf(change(runState(['ann', 'bob', 'cat'])), 'ann', facts)
		expect(shown.players.bob.status).toBe(status)
		expect(shown.players.ann.status).toBe('playing')
		expect(shown.players.cat.status).toBe('playing')
	})

	it('a waiting death names the player and what it waits on', () => {
		const shown = viewOf(waiting(runState(['ann', 'bob', 'cat'])), 'ann')
		expect(shown.match.run?.waitingDeaths).toEqual([
			{ player: 'bob', blindKey: '3:Big', waitingFor: ['ann'] },
		])
	})

	it('away before the run: status comes from the facts alone', () => {
		const state: State = { ...runState(['ann', 'bob']), run: null }
		expect(viewOf(state, 'ann', AWAY).players.bob.status).toBe('away')
	})
})

describe('match result', () => {
	// The wire shape the game reads: a win or draw says `rated` as a boolean, never `rating`.
	const RESULTS: [string, MatchResult, unknown][] = [
		[
			'win',
			winResult(['bob', 'ann'], true),
			{ kind: 'win', winners: ['ann', 'bob'], rated: true },
		],
		[
			'unrated win',
			winResult(['bob'], false),
			{ kind: 'win', winners: ['bob'], rated: false },
		],
		['draw', drawResult(false), { kind: 'draw', rated: false }],
		['rated draw', drawResult(true), { kind: 'draw', rated: true }],
		['agreed', agreedResult(), { kind: 'agreed' }],
		['abandoned', abandonedResult(), { kind: 'abandoned' }],
		['contested', { kind: 'contested' }, { kind: 'contested' }],
		['restarted', restartedResult(), { kind: 'restarted' }],
	]

	it.each(RESULTS)(
		'%s is sent in its wire shape, and the stage is ended',
		(_name, result, wire) => {
			for (const base of [
				runState(['ann', 'bob']),
				{ ...runState(['ann']), run: null },
			]) {
				const shown = viewOf({ ...base, result }, 'ann')
				expect(shown.match.result).toEqual(wire)
				expect(JSON.stringify(shown.match.result)).toBe(JSON.stringify(wire))
				expect(shown.match.stage).toBe('ended')
			}
		},
	)

	it('a state after a restart has no result and a fresh run', () => {
		const old: State = {
			...runState(['ann', 'bob']),
			result: restartedResult(),
		}
		const fresh: State = { ...runState(['ann', 'bob']), result: null }
		expect(viewOf(old, 'ann').match.stage).toBe('ended')
		const shown = viewOf(fresh, 'ann')
		expect(shown.match.result).toBeNull()
		expect(shown.match.stage).toBe('run')
		expect(shown.match.run?.finishedPvpBlinds).toEqual([])
		expect(shown.onlyMine.inboxNewest).toBe(0)
	})
})

describe('places and end games', () => {
	const endGame = (tag: string): EndGame => ({
		jokers: `jokers-${tag}`,
		deck: `deck-${tag}`,
		stats: { rerollCount: 1, rerollCostTotal: 2 },
	})
	const withEndGames = (result: MatchResult | null): State => {
		const base = runState(['ann', 'bob', 'cat'])
		return {
			...base,
			run: {
				...runOf(base),
				places: { bob: 2, ann: 1 },
				endGames: { ann: endGame('a'), bob: endGame('b') },
			},
			result,
		}
	}

	it("others' end games come only when the match has ended, mine never", () => {
		const shown = viewOf(withEndGames(winResult(['ann'], true)), 'ann')
		expect(shown.players.ann).not.toHaveProperty('endGame')
		expect(shown.players.bob.endGame).toEqual(endGame('b'))
		expect(shown.players.cat).not.toHaveProperty('endGame')
	})

	it('no end game is shown while the match is on', () => {
		const shown = viewOf(withEndGames(null), 'cat')
		for (const player of Object.values(shown.players))
			expect(player).not.toHaveProperty('endGame')
	})

	it('a place is shown when the run holds it, and left out otherwise', () => {
		const shown = viewOf(withEndGames(null), 'cat')
		expect(shown.players.ann.place).toBe(1)
		expect(shown.players.bob.place).toBe(2)
		expect(shown.players.cat).not.toHaveProperty('place')
	})
})

describe('latest jokers', () => {
	const endGame: EndGame = {
		jokers: 'end-b',
		deck: 'deck-b',
		stats: { rerollCount: 1, rerollCostTotal: 2 },
	}
	const withJokers = (
		result: MatchResult | null,
		out: PlayerId[],
		endGames: { [player: string]: EndGame } = {},
	): State => {
		const base = runState(['ann', 'bob', 'cat'])
		const run = runOf(base)
		return {
			...base,
			run: {
				...run,
				lives: Object.fromEntries(
					Object.entries(run.lives).map(([id, seat]) => [
						id,
						out.includes(id)
							? { ...seat, lives: 0, status: 'out' as const }
							: seat,
					]),
				),
				lastJokers: { ann: 'ann-jokers', bob: 'bob-jokers' },
				endGames,
			},
			result,
		}
	}

	it('comes to a viewer who is out, for the players who sent them, and not for the viewer', () => {
		const shown = viewOf(withJokers(null, ['cat']), 'cat')
		expect(shown.players.ann.jokers).toBe('ann-jokers')
		expect(shown.players.bob.jokers).toBe('bob-jokers')
		expect(shown.players.cat).not.toHaveProperty('jokers')
	})

	it("is a player's end game jokers once their game ended, before the match result", () => {
		const shown = viewOf(withJokers(null, ['cat'], { bob: endGame }), 'cat')
		expect(shown.players.bob.jokers).toBe(endGame.jokers)
		expect(shown.players.bob).not.toHaveProperty('endGame')
		expect(shown.players.ann.jokers).toBe('ann-jokers')
	})

	it('stays the last shop exit jokers when the end game came with no jokers text', () => {
		const shown = viewOf(
			withJokers(null, ['cat'], { bob: { ...endGame, jokers: '' } }),
			'cat',
		)
		expect(shown.players.bob.jokers).toBe('bob-jokers')
	})

	it('comes to a viewer who left', () => {
		const shown = viewOf(withJokers(null, []), 'cat', {
			...FACTS,
			left: ['cat'],
		})
		expect(shown.players.ann.jokers).toBe('ann-jokers')
	})

	it('does not come to a viewer still playing, or away', () => {
		for (const facts of [FACTS, { ...FACTS, away: ['cat'] }]) {
			const shown = viewOf(withJokers(null, []), 'cat', facts)
			for (const player of Object.values(shown.players))
				expect(player).not.toHaveProperty('jokers')
		}
	})

	it('comes to every viewer once the match has ended', () => {
		const shown = viewOf(withJokers(winResult(['ann'], true), []), 'cat')
		expect(shown.players.ann.jokers).toBe('ann-jokers')
	})

	it('is replaced by the endGame when it has jokers', () => {
		const shown = viewOf(
			withJokers(winResult(['ann'], true), [], { bob: endGame }),
			'cat',
		)
		expect(shown.players.bob.endGame).toEqual(endGame)
		expect(shown.players.bob).not.toHaveProperty('jokers')
		expect(shown.players.ann.jokers).toBe('ann-jokers')
	})

	it('is left out once an endGame came, also with no jokers text', () => {
		const shown = viewOf(
			withJokers(winResult(['ann'], true), [], {
				bob: { ...endGame, jokers: '' },
			}),
			'cat',
		)
		expect(shown.players.bob).not.toHaveProperty('jokers')
	})
})

describe('grace', () => {
	it('is added last to the countdowns, as the lobby gave it', () => {
		const state = duelMidBlind()
		const facts: ViewFacts = {
			...FACTS,
			away: ['bob'],
			grace: { against: ['bob'], endsAt: 99_000 },
		}
		const { deadlines } = viewOf(state, 'ann', facts).timers
		expect(deadlines.map((deadline) => deadline.kind)).toEqual(['grace'])
		expect(deadlines[0]).toEqual({
			kind: 'grace',
			by: null,
			against: ['bob'],
			endsAt: 99_000,
			pausedAt: null,
			hold: 'counting',
		})
	})

	it('none, none', () => {
		expect(
			viewOf(duelMidBlind(), 'ann').timers.deadlines.map(
				(deadline) => deadline.kind,
			),
		).toEqual([])
	})
})

describe('teams: the team sums are as hidden as the scores', () => {
	const teams: { [player: string]: Team } = {
		ann: 'A',
		bob: 'A',
		cat: 'B',
		dee: 'B',
	}
	function teamPvpBlind(): State {
		const players = Object.keys(teams)
		const base = runInMode(players, 'teams', teams)
		let state: State = {
			...base,
			run: { ...runOf(base), teamLives: { A: 4, B: 4 } },
		}
		for (const player of players) state = ready(state, player).state
		players.forEach((player, at) => {
			state = send(state, player, {
				kind: 'blindStart',
				blindKey: BLIND,
				handsLeft: 4,
				score: String((at + 1) * 111),
			}).state
		})
		return state
	}

	it('are not shown while the viewer has played no hand and a score is hidden', () => {
		const shown = viewOf(teamPvpBlind(), 'ann')
		expect(shown.match.run?.currentPvpBlind?.players.cat).toMatchObject({
			score: { kind: 'hidden' },
		})
		expect(shown.match.run?.targets.teamScores).toBeNull()
		expect(JSON.stringify(shown)).not.toMatch(/"(333|444|777)"/)
	})

	it('are the real team sums once the viewer has played a hand', () => {
		const played = send(teamPvpBlind(), 'ann', {
			kind: 'handScored',
			blindKey: BLIND,
			handsLeft: 3,
			score: '111',
		}).state
		const shown = viewOf(played, 'ann')
		expect(shown.match.run?.targets.teamScores).toEqual({ A: '333', B: '777' })
		expect(viewOf(played, 'cat').match.run?.targets.teamScores).toBeNull()
	})

	it('are not shown while only one team has reported a score', () => {
		const players = Object.keys(teams)
		const base = runInMode(players, 'teams', teams)
		let state: State = {
			...base,
			run: { ...runOf(base), teamLives: { A: 4, B: 4 } },
		}
		for (const player of players) state = ready(state, player).state
		for (const player of ['ann', 'bob'])
			state = send(state, player, {
				kind: 'blindStart',
				blindKey: BLIND,
				handsLeft: 4,
				score: '111',
			}).state
		state = send(state, 'ann', {
			kind: 'handScored',
			blindKey: BLIND,
			handsLeft: 3,
			score: '111',
		}).state
		expect(viewOf(state, 'ann').match.run?.targets.teamScores).toBeNull()
	})

	it('every player shows the team they are on', () => {
		const shown = viewOf(teamPvpBlind(), 'ann')
		expect(
			Object.fromEntries(
				Object.entries(shown.players).map(([id, one]) => [id, one.team]),
			),
		).toEqual(teams)
	})
})

// ---- laws over random legal play ----

type Move =
	| { kind: 'progress'; ante: number }
	| { kind: 'ready'; value: boolean }
	| { kind: 'handScored'; hands: number }
	| { kind: 'handPlayed'; hands: number }
	| { kind: 'timerStart'; timer: 'ante' | 'pvp' }
	| { kind: 'animating'; on: boolean }
	| { kind: 'forfeit' }
	| { kind: 'tick'; seconds: number }

const moveArbitrary: fc.Arbitrary<Move> = fc.oneof(
	fc.record({
		kind: fc.constant('progress' as const),
		ante: fc.integer({ min: 1, max: 4 }),
	}),
	fc.record({ kind: fc.constant('ready' as const), value: fc.boolean() }),
	fc.record({
		kind: fc.constant('handScored' as const),
		hands: fc.integer({ min: 0, max: 3 }),
	}),
	fc.record({
		kind: fc.constant('handPlayed' as const),
		hands: fc.integer({ min: 0, max: 3 }),
	}),
	fc.record({
		kind: fc.constant('timerStart' as const),
		timer: fc.constantFrom('ante', 'pvp'),
	}),
	fc.record({ kind: fc.constant('animating' as const), on: fc.boolean() }),
	fc.record({ kind: fc.constant('forfeit' as const) }),
	fc.record({
		kind: fc.constant('tick' as const),
		seconds: fc.integer({ min: 1, max: 400 }),
	}),
)

interface Setup {
	players: string[]
	make: () => State
}

const SETUPS: Setup[] = [
	{ players: ['ann', 'bob'], make: () => runInMode(['ann', 'bob'], 'nemesis') },
	{
		players: ['ann', 'bob', 'cat'],
		make: () => runInMode(['ann', 'bob', 'cat'], 'royale'),
	},
	{
		players: ['ann', 'bob', 'cat', 'dee'],
		make: () => {
			const base = runInMode(['ann', 'bob', 'cat', 'dee'], 'teams', {
				ann: 'A',
				bob: 'A',
				cat: 'B',
				dee: 'B',
			})
			return { ...base, run: { ...runOf(base), teamLives: { A: 4, B: 4 } } }
		},
	},
]

// Every score is told apart by its step and player, so a hidden one can be searched for.
function play(
	setup: Setup,
	steps: { who: number; move: Move }[],
): { state: State; seconds: number } {
	const { players } = setup
	let state = setup.make()
	let seconds = 0
	state = progress(state, players, 2)
	for (const player of players) state = ready(state, player).state
	players.forEach((player, at) => {
		state = send(state, player, {
			kind: 'blindStart',
			blindKey: BLIND,
			handsLeft: 4,
			score: String(70_000 + at),
		}).state
	})
	steps.forEach(({ who, move }, at) => {
		const player = players[who % players.length]
		const score = String(100_000 + at * 10 + who)
		if (move.kind === 'tick') {
			seconds += move.seconds
			state = tick(state, seconds * 1000, { ranked: false })
			return
		}
		const body = {
			progress: {
				kind: 'progress',
				ante: move.kind === 'progress' ? move.ante : 0,
				location: 'blind',
			},
			ready: {
				kind: 'ready',
				ready: move.kind === 'ready' ? move.value : true,
				blindKey: BLIND,
			},
			handScored: {
				kind: 'handScored',
				blindKey: BLIND,
				handsLeft: move.kind === 'handScored' ? move.hands : 0,
				score,
			},
			handPlayed: {
				kind: 'handPlayed',
				blindKey: BLIND,
				handsLeft: move.kind === 'handPlayed' ? move.hands : 0,
			},
			timerStart: {
				kind: 'timerStart',
				timer: move.kind === 'timerStart' ? move.timer : 'ante',
			},
			animating: {
				kind: 'animating',
				on: move.kind === 'animating' ? move.on : false,
			},
			forfeit: { kind: 'forfeit' },
		}[move.kind]
		state = send(state, player, body, seconds * 1000).state
	})
	return { state, seconds }
}

const playArbitrary = fc.record({
	setup: fc.constantFrom(...SETUPS),
	steps: fc.array(
		fc.record({ who: fc.integer({ min: 0, max: 3 }), move: moveArbitrary }),
		{ maxLength: 24 },
	),
})

const clone = <Value>(value: Value): Value => structuredClone(value)

describe('what a view holds, over random legal play', () => {
	it('view_never_contains_hidden: no hidden score or inbox of another player', () => {
		fc.assert(
			fc.property(playArbitrary, ({ setup, steps }) => {
				const { state, seconds } = play(setup, steps)
				const run = state.run
				for (const viewer of setup.players) {
					const shown = viewOf(state, viewer, FACTS, seconds * 1000)
					const text = JSON.stringify(shown)
					const currentPvpBlind = run?.currentPvpBlind
					if (currentPvpBlind)
						for (const [player, entry] of Object.entries(
							currentPvpBlind.players,
						))
							if (
								player !== viewer &&
								scoreOf(entry) !== null &&
								!mayLookAtScores(currentPvpBlind, viewer)
							)
								expect(text).not.toContain(`"${scoreOf(entry)}"`)
					const mine = run?.players[viewer]
					expect(shown.onlyMine.inbox).toEqual(
						mine?.inbox.slice(
							mine.inboxDone,
							mine.inboxDone + INBOX_ITEMS_PER_VIEW,
						) ?? [],
					)
				}
			}),
			{ numRuns: 300 },
		)
	})

	it('what another player holds privately changes nothing in my view', () => {
		fc.assert(
			fc.property(playArbitrary, ({ setup, steps }) => {
				const { state } = play(setup, steps)
				const run = state.run
				if (run === null) return
				for (const viewer of setup.players) {
					const stripped: State = {
						...state,
						run: {
							...run,
							players: Object.fromEntries(
								Object.entries(run.players).map(([player, entry]) => [
									player,
									player === viewer
										? entry
										: { ...entry, inbox: [], inboxDone: 0, totals: {} },
								]),
							),
						},
					}
					expect(viewOf(stripped, viewer)).toEqual(viewOf(state, viewer))
				}
			}),
			{ numRuns: 200 },
		)
	})

	it('is a pure read: same in, same view, state untouched', () => {
		fc.assert(
			fc.property(playArbitrary, ({ setup, steps }) => {
				const { state } = play(setup, steps)
				const before = clone(state)
				for (const viewer of setup.players) {
					const first = viewOf(state, viewer)
					expect(viewOf(state, viewer)).toEqual(first)
					expect(viewOf(clone(state), viewer)).toEqual(first)
				}
				expect(state).toEqual(before)
			}),
			{ numRuns: 100 },
		)
	})
})

describe('quiet_tick_view_identical', () => {
	it('a tick that crosses no deadline gives the same view, serverTime apart', () => {
		let state = duelMidBlind()
		state = send(state, 'bob', { kind: 'animating', on: true }, 1_000).state
		const before = ['ann', 'bob'].map((player) =>
			viewOf(state, player, FACTS, 1_000),
		)
		for (const seconds of [2, 30, 90]) {
			const ticked = tick(state, seconds * 1000, { ranked: true })
			;['ann', 'bob'].forEach((player, at) => {
				expect(viewOf(ticked, player, FACTS, seconds * 1000)).toEqual({
					...before[at],
					serverTime: seconds * 1000,
				})
			})
		}
	})
})

describe('view_fits_one_message', () => {
	const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
	const SCORE = '1.7976931348623157e+308'

	const finishedPvpBlinds = (): PvpBlindResult[] =>
		Array.from({ length: 10 }, (_, at) => ({
			blindKey: `${at + 2}:Boss`,
			scores: Object.fromEntries(ids.map((id) => [id, SCORE])),
			endedBy: Object.fromEntries(ids.map((id) => [id, 'timer' as const])),
			losers: ids.slice(0, 4),
			close: 'played out',
			livesAfter: Object.fromEntries(ids.map((id) => [id, 4])),
			teamScores: null,
		}))

	// The largest inbox item.
	const biggestPlainItem = (itemNumber: number): InboxItem => ({
		itemNumber,
		from: 'p2',
		effect: 'comebackBonus',
		amount: 1_000_000,
	})

	function fullRun(
		makeItem: (itemNumber: number) => InboxItem,
		result: MatchResult | null,
		endGame: EndGame | null,
	): State {
		const base = runInMode(ids, 'royale')
		const run = runOf(base)
		const items = Array.from({ length: 40 }, (_, at) => makeItem(at + 1))
		return {
			...base,
			run: {
				...run,
				players: Object.fromEntries(
					ids.map((id) => [
						id,
						{
							...run.players[id],
							ante: 8,
							location: 'a-long-location-name',
							sells: Object.fromEntries(
								Array.from({ length: 8 }, (_, at) => [String(at + 1), 99]),
							),
							shopSpends: Object.fromEntries(
								Array.from({ length: 40 }, (_, at) => [String(at + 1), 9999]),
							),
							inbox: items,
							inboxDone: 0,
						},
					]),
				),
				finishedPvpBlinds: finishedPvpBlinds(),
				votes: { draw: ids, seed: ids },
				places: Object.fromEntries(ids.map((id, at) => [id, at + 1])),
				endGames:
					endGame === null
						? {}
						: Object.fromEntries(ids.map((id) => [id, endGame])),
			},
			result,
		}
	}

	it('the run on: 32 of the largest plain inbox items, 8 players, ten PvP blinds, under 32,768 bytes', () => {
		const shown = viewOf(fullRun(biggestPlainItem, null, null), 'p1')
		expect(shown.onlyMine.inbox).toHaveLength(INBOX_ITEMS_PER_VIEW)
		expect(bytesOf(shown)).toBeLessThan(32_768)
	})

	it('the ended view: seven end games of the largest non-ASCII text the server takes stay under 65,536 bytes', () => {
		const stats = { rerollCount: 1_000_000, rerollCostTotal: 1_000_000 }
		const overhead = utf8Bytes(JSON.stringify({ jokers: '', deck: '', stats }))
		// Three bytes a letter: the most that fits the cap, half in each field.
		const half = Math.floor((END_GAME_TEXT_MAX - overhead) / 2 / 3)
		const endGame: EndGame = {
			jokers: '€'.repeat(half),
			deck: '€'.repeat(half),
			stats,
		}
		expect(utf8Bytes(JSON.stringify(endGame))).toBeLessThanOrEqual(
			END_GAME_TEXT_MAX,
		)
		const shown = viewOf(
			fullRun(biggestPlainItem, winResult(['p1'], true), endGame),
			'p1',
		)
		expect(Object.values(shown.players).filter((p) => p.endGame)).toHaveLength(
			7,
		)
		expect(bytesOf(shown)).toBeLessThan(65_536)
	})

	it('the ended view carries the other seven end games and not mine', () => {
		const stats = { rerollCount: 1_000_000, rerollCostTotal: 1_000_000 }
		const overhead = JSON.stringify({ jokers: '', deck: '', stats }).length
		const half = Math.floor((END_GAME_TEXT_MAX - overhead) / 2)
		const endGame: EndGame = {
			jokers: 'j'.repeat(half),
			deck: 'd'.repeat(half),
			stats,
		}
		expect(JSON.stringify(endGame).length).toBeLessThanOrEqual(
			END_GAME_TEXT_MAX,
		)
		const shown = viewOf(
			fullRun(biggestPlainItem, winResult(['p1'], true), endGame),
			'p1',
		)
		expect(Object.values(shown.players).filter((p) => p.endGame)).toHaveLength(
			7,
		)
		expect(shown.players.p1).not.toHaveProperty('endGame')
		// The size cap in the server config is on what a game sends up, not on a view.
		expect(bytesOf(shown)).toBeLessThan(65_536)
	})

	it('the largest ones for seven players keep the view under 65,536 bytes', () => {
		const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
		const base = fullRun(biggestPlainItem, winResult(['p1'], true), null)
		const run = runOf(base)
		const largest = 'j'.repeat(JOKERS_TEXT_MAX)
		const shown = viewOf(
			{
				...base,
				run: {
					...run,
					lastJokers: Object.fromEntries(ids.map((id) => [id, largest])),
				},
			},
			'p1',
		)
		expect(Object.values(shown.players).filter((p) => p.jokers)).toHaveLength(7)
		expect(bytesOf(shown)).toBeLessThan(65_536)
	})

	it('the worst case together: an end game with only a deck, or the largest non-ASCII jokers with none', () => {
		const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
		const stats = { rerollCount: 1_000_000, rerollCostTotal: 1_000_000 }
		const overhead = utf8Bytes(JSON.stringify({ jokers: '', deck: '', stats }))
		const deckOnly: EndGame = {
			jokers: '',
			deck: '€'.repeat(Math.floor((END_GAME_TEXT_MAX - overhead) / 3)),
			stats,
		}
		for (const endGame of [deckOnly, null]) {
			const base = fullRun(biggestPlainItem, winResult(['p1'], true), endGame)
			const run = runOf(base)
			const shown = viewOf(
				{
					...base,
					run: {
						...run,
						lastJokers: Object.fromEntries(
							ids.map((id) => [id, '€'.repeat(JOKERS_TEXT_MAX)]),
						),
					},
				},
				'p1',
			)
			expect(Object.values(shown.players).filter((p) => p.jokers)).toHaveLength(
				endGame === null ? 7 : 0,
			)
			expect(bytesOf(shown)).toBeLessThan(65_536)
		}
	})

	it('a run checkpointed before lastJokers existed shows no jokers and does not throw', () => {
		const base = fullRun(biggestPlainItem, winResult(['p1'], true), null)
		const { lastJokers: _gone, ...old } = runOf(base)
		const shown = viewOf({ ...base, run: old as typeof base.run }, 'p1')
		for (const player of Object.values(shown.players))
			expect(player).not.toHaveProperty('jokers')
	})
})

describe('limits of one view', () => {
	it('LIMITS is the frozen limits the run carries', () => {
		expect(
			viewOf(runState(['ann', 'bob']), 'ann').match.run?.rules.limits,
		).toEqual(LIMITS)
	})
})
