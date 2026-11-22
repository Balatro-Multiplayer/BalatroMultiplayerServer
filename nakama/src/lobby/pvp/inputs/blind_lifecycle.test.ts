import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isCounting } from '../core/clock'
import { tick } from '../core/tick'
import type { PlayerId, State } from '../core/types'
import { targetsOf } from '../rules/opponent_targets'
import {
	isInRun,
	isPvpBlind,
	playersOfBoss,
	requiredPlayers,
} from '../rules/players'
import { isAway } from '../rules/pvp_blind_rules'
import { type ShellFacts, shellTick } from '../match_hooks/pvp_shell'
import { drop, ready, runOf, send } from '../testing/inputs'
import {
	droppedAt,
	pairedRun,
	reported,
	runInMode,
	runState,
} from '../testing/state'
import { countdownsOf, livesOf, start } from '../testing/timers'
import { endPvpBlindFor, pvpBlindView, settlePvpBlind } from './pvp_blind'
import { dropUnneededTimers, runOutTimers } from './timer_run_out'

const BOSS = '2:Boss'
const HOUR = 3_600_000
const NAMES = ['ann', 'bob', 'cat', 'dan', 'eli']

const facts = (away: PlayerId[]): ShellFacts => ({
	gameStarted: true,
	away,
	left: [],
	grace: null,
	messageNumbers: {},
	ranked: true,
	forfeited: [],
	awayFrom: droppedAt(away),
})

// Neighbours are paired; an odd one out has the bye.
const partnersOf = (players: PlayerId[]): { [player: string]: string | null } =>
	Object.fromEntries(
		players.map((player, index) => {
			const partner = players[index % 2 === 0 ? index + 1 : index - 1]
			return [player, partner ?? null]
		}),
	)

const progress = (state: State, player: PlayerId, ante: number): State =>
	send(state, player, { kind: 'progress', ante, location: 'shop' }).state

// Ann and Cat are a pair, Bob and Dan the other; all are on ante 2.
const fourPlayers = (): State =>
	pairedRun(['ann', 'bob', 'cat', 'dan'], {
		ann: 'cat',
		cat: 'ann',
		bob: 'dan',
		dan: 'bob',
	})

// Whether a Ready press for the player's own Boss is accepted.
const pressAccepted = (state: State, player: PlayerId): boolean => {
	const ante = runOf(state).players[player].ante
	return ready(state, player, true, `${ante}:Boss`).refusals.length === 0
}

describe('the PvP blind waits on everyone still in', () => {
	it('a Nemesis bye is waited on, and plays a normal Boss', () => {
		const three = pairedRun(['ann', 'bob', 'cat'], {
			ann: 'bob',
			bob: 'ann',
			cat: null,
		})
		const waiting = ready(
			ready(three, 'ann', true, BOSS).state,
			'bob',
			true,
			BOSS,
		).state
		expect(runOf(waiting).currentPvpBlind).toBeNull()
		expect(targetsOf(waiting, 'cat').myBoss).toBe('bye')
		const opened = ready(waiting, 'cat', true, BOSS).state
		expect(
			Object.keys(runOf(opened).currentPvpBlind?.players ?? {}).sort(),
		).toEqual(['ann', 'bob', 'cat'])
	})

	it('a player who is out is not waited on', () => {
		const dropped = drop(fourPlayers(), 'dan', 'forfeit', 0)
		const opened = ['ann', 'bob', 'cat'].reduce(
			(next, player) => ready(next, player, true, BOSS).state,
			dropped,
		)
		expect(
			Object.keys(runOf(opened).currentPvpBlind?.players ?? {}).sort(),
		).toEqual(['ann', 'bob', 'cat'])
	})

	it('a Ready press for another Boss, or while a PvP blind plays, is refused', () => {
		const playing = ['ann', 'bob', 'cat', 'dan'].reduce(
			(next, player) => ready(next, player, true, BOSS).state,
			fourPlayers(),
		)
		expect(ready(playing, 'ann', true, BOSS).refusals).toEqual([
			'pvp_blind_playing',
		])
		expect(ready(playing, 'ann', true, '3:Boss').refusals).toEqual([
			'wrong_blind',
		])
	})
})

describe('the last two players (361)', () => {
	it('the view of each player agrees with whether their Ready press is accepted', () => {
		const state = pairedRun(['ann', 'bob', 'cat'], {
			ann: 'cat',
			cat: 'ann',
			bob: null,
		})
		const waiting = ready(state, 'ann', true, BOSS).state
		const dropped = drop(waiting, 'cat', 'left', 0)
		for (const player of ['ann', 'bob'])
			expect(targetsOf(dropped, player).myBoss !== 'no pvp this ante').toBe(
				pressAccepted(dropped, player),
			)
	})
})

describe('a Ready player who is away', () => {
	const duo = (): State => reported(runState(['ann', 'bob']))

	it('is refused Ready for a Boss before an ante is reported (463)', () => {
		const pressed = ready(runState(['ann', 'bob']), 'ann')
		expect(pressed.refusals).toEqual(['wrong_blind'])
		expect(runOf(pressed.state).ready).toEqual({})
	})

	it('loses the Ready mark when they come back, so no PvP blind opens under their shop (462)', () => {
		const pressed = ready(duo(), 'ann').state
		const away = shellTick(pressed, 1000, facts(['ann']))
		expect(runOf(away).ready.ann).toBe(BOSS)
		const back = shellTick(away, 2000, facts([]))
		expect(runOf(back).ready).toEqual({})
		const bobReady = ready(back, 'bob', true, BOSS, 3000).state
		expect(runOf(bobReady).currentPvpBlind).toBeNull()
	})

	it('still counts while away: the PvP blind opens and their away pause goes on', () => {
		const away = shellTick(duo(), 1000, facts(['bob']))
		const pressed = ready(ready(away, 'ann').state, 'bob').state
		expect(
			Object.keys(runOf(pressed).currentPvpBlind?.players ?? {}).sort(),
		).toEqual(['ann', 'bob'])
		expect(isAway(runOf(pressed), 'bob')).toBe(true)
	})
})

describe('a Ready player whose PvP Boss still needs them', () => {
	it('is refused a normal blindResult for it', () => {
		const waiting = ready(fourPlayers(), 'ann', true, BOSS).state
		const result = send(waiting, 'ann', {
			kind: 'blindResult',
			blindKey: BOSS,
			result: 'lost',
		})
		expect(result.refusals).toEqual(['pvp_blind'])
		expect(livesOf(result.state, 'ann')).toBe(livesOf(waiting, 'ann'))
	})
})

describe('an Ante countdown whose starter took back Ready (421)', () => {
	const timed = (): State =>
		start(ready(fourPlayers(), 'bob', true, BOSS).state, 'bob', 'ante').state

	it('charges nobody once the starter sends ready false', () => {
		const taken = ready(timed(), 'bob', false, BOSS)
		expect(taken.refusals).toEqual([])
		const ran = runOutTimers(taken.state, HOUR)
		for (const player of ['ann', 'bob', 'cat', 'dan'])
			expect(livesOf(ran, player)).toBe(livesOf(taken.state, player))
	})

	it('pauses the starter countdown with the time left, and starting again resumes it (442)', () => {
		const before = start(
			ready(fourPlayers(), 'bob', true, BOSS).state,
			'bob',
			'ante',
		).state
		const [counting] = countdownsOf(before)
		const taken = ready(before, 'bob', false, BOSS, 10_000).state
		const [paused] = countdownsOf(taken)
		expect(paused.hold).toEqual({ kind: 'paused by starter', sinceAt: 10_000 })
		expect(paused.endsAt).toBe(counting.endsAt)
		const again = start(
			ready(taken, 'bob', true, BOSS, 30_000).state,
			'bob',
			'ante',
			30_000,
		).state
		const [resumed] = countdownsOf(again)
		expect(resumed.hold).toEqual({ kind: 'counting' })
		expect(resumed.endsAt).toBe(counting.endsAt + 20_000)
	})

	it('a loss to another countdown does not start a paused countdown again for a starter who is not Ready', () => {
		const paused = ready(timed(), 'bob', false, BOSS, 1000).state
		const annTimes = start(
			ready(paused, 'ann', true, BOSS, 2000).state,
			'ann',
			'ante',
			2000,
		).state
		const ran = runOutTimers(annTimes, HOUR)
		expect(livesOf(ran, 'cat')).toBe(livesOf(annTimes, 'cat') - 1)
		expect(
			countdownsOf(ran).filter(
				(countdown) =>
					countdown.kind === 'ante' &&
					countdown.by === 'bob' &&
					isCounting(countdown),
			),
		).toEqual([])
	})

	it('the Ante countdown is spent once the starter is out of the Boss, Ready or not', () => {
		const dropped = drop(timed(), 'bob', 'forfeit', 0)
		expect(
			dropUnneededTimers(dropped, 0).run?.clocks.countdowns.filter(
				(countdown) => countdown.kind === 'ante',
			),
		).toEqual([])
	})

	it('costs a life only to a player who is not Ready, and never to the Ready ones', () => {
		const ran = runOutTimers(timed(), HOUR)
		expect(livesOf(ran, 'bob')).toBe(livesOf(timed(), 'bob'))
		expect(livesOf(ran, 'ann')).toBe(livesOf(timed(), 'ann') - 1)
		expect(livesOf(ran, 'cat')).toBe(livesOf(timed(), 'cat') - 1)
		expect(livesOf(ran, 'dan')).toBe(livesOf(timed(), 'dan') - 1)
	})
})

describe('the waiting view', () => {
	it('shows no waiting PvP blind while nobody is Ready, and one once somebody is', () => {
		expect(pvpBlindView(fourPlayers(), 'ann')).toBeNull()
		const pressed = ready(fourPlayers(), 'ann', true, BOSS).state
		expect(pvpBlindView(pressed, 'ann')).toMatchObject({
			stage: 'waiting',
			blindKey: BOSS,
		})
	})

	it('a resolved Boss answers plays to who played it and no pvp to anyone else', () => {
		const state = fourPlayers()
		const resolved: State = {
			...state,
			run: {
				...runOf(state),
				finishedPvpBlinds: [
					{
						blindKey: BOSS,
						scores: { bob: null, dan: null },
						endedBy: { bob: 'hands', dan: 'hands' },
						losers: ['dan'],
						livesAfter: {},
						teamScores: null,
					},
				],
			},
		}
		expect(targetsOf(resolved, 'bob').myBoss).toBe('plays')
		expect(targetsOf(resolved, 'ann').myBoss).toBe('no pvp this ante')
	})
})

describe('the Boss opening on a tick (426)', () => {
	it('opens once a run-out life loss leaves only Ready players', () => {
		let state = runInMode(['ann', 'bob', 'cat'], 'royale')
		for (const player of ['ann', 'bob', 'cat'])
			state = progress(state, player, 2)
		const run = runOf(state)
		state = {
			...state,
			run: {
				...run,
				lives: { ...run.lives, cat: { ...run.lives.cat, lives: 1 } },
			},
		}
		state = start(
			ready(ready(state, 'ann', true, BOSS).state, 'bob', true, BOSS).state,
			'ann',
			'ante',
		).state
		expect(runOf(state).currentPvpBlind).toBeNull()
		const ticked = tick(state, HOUR, { ranked: true })
		expect(runOf(ticked).currentPvpBlind?.blindKey).toBe(BOSS)
		expect(
			Object.keys(runOf(ticked).currentPvpBlind?.players ?? {}).sort(),
		).toEqual(['ann', 'bob'])
	})
})

describe("a Duel closes on the mode's word, not on a Play press (440)", () => {
	const duel = (): State =>
		['ann', 'bob'].reduce(
			(next, player) => ready(next, player, true, BOSS).state,
			pairedRun(['ann', 'bob'], { ann: 'bob', bob: 'ann' }),
		)
	const enter = (
		state: State,
		player: PlayerId,
		handsLeft: number,
		score: string,
	): State =>
		send(state, player, {
			kind: 'blindStart',
			blindKey: BOSS,
			handsLeft,
			score,
		}).state
	const scoredBy = (
		state: State,
		player: PlayerId,
		handsLeft: number,
		score: string,
	): State =>
		send(state, player, {
			kind: 'handScored',
			blindKey: BOSS,
			handsLeft,
			score,
		}).state
	const entered = (): State =>
		enter(enter(duel(), 'ann', 1, '0'), 'bob', 3, '500')
	const lastHandPlayed = (): State =>
		send(entered(), 'ann', {
			kind: 'handPlayed',
			blindKey: BOSS,
			handsLeft: 0,
		}).state

	it('keeps the PvP blind open while the last hand is played but not yet scored', () => {
		const state = lastHandPlayed()
		expect(runOf(state).currentPvpBlind).not.toBeNull()
		expect(livesOf(state, 'ann')).toBe(4)
	})

	it('counts the last hand once it is scored: a winning one keeps the PvP blind open', () => {
		const state = scoredBy(lastHandPlayed(), 'ann', 0, '700')
		expect(runOf(state).currentPvpBlind?.players.ann).toMatchObject({
			stage: 'done',
			score: '700',
		})
		expect(livesOf(state, 'ann')).toBe(4)
		expect(runOf(state).currentPvpBlind).not.toBeNull()
	})

	it('closes the PvP blind the moment the trailing player scores their last hand', () => {
		const state = scoredBy(lastHandPlayed(), 'ann', 0, '100')
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect(runOf(state).finishedPvpBlinds[0].losers).toEqual(['ann'])
		expect(livesOf(state, 'ann')).toBe(3)
		expect(livesOf(state, 'bob')).toBe(4)
	})

	it('a player the timer ended loses even while ahead (two-player PvP blind)', () => {
		const leader = enter(enter(duel(), 'ann', 3, '1'), 'bob', 3, '900')
		const timed = settlePvpBlind(endPvpBlindFor(leader, 'bob', 'timer'), 5)
		expect(runOf(timed).currentPvpBlind).toBeNull()
		expect(runOf(timed).finishedPvpBlinds[0].losers).toEqual(['bob'])
		expect(livesOf(timed, 'bob')).toBe(3)
		expect(livesOf(timed, 'ann')).toBe(4)
	})
})

const withTeamLives = (state: State): State => {
	const run = runOf(state)
	return { ...state, run: { ...run, teamLives: { A: 4, B: 4 } } }
}

describe('a player the PvP timer ended loses a life in every PvP blind size', () => {
	const THREE = ['ann', 'bob', 'cat']
	const FOUR = ['ann', 'bob', 'cat', 'dan']
	const enterAll = (
		state: State,
		scores: { [player: string]: string },
	): State =>
		Object.keys(scores).reduce(
			(next, player) =>
				send(next, player, {
					kind: 'blindStart',
					blindKey: BOSS,
					handsLeft: 1,
					score: scores[player],
				}).state,
			state,
		)
	const finish = (state: State, scores: { [player: string]: string }): State =>
		Object.keys(scores).reduce(
			(next, player) =>
				send(next, player, {
					kind: 'handScored',
					blindKey: BOSS,
					handsLeft: 0,
					score: scores[player],
				}).state,
			state,
		)
	const open = (state: State, players: PlayerId[]): State =>
		players.reduce(
			(next, player) =>
				ready(progress(next, player, 2), player, true, BOSS).state,
			state,
		)

	it('Royale: the timed player and the lowest score both pay, the other does not', () => {
		const scores = { ann: '1', bob: '2', cat: '9' }
		let state = enterAll(open(runInMode(THREE, 'royale'), THREE), scores)
		state = endPvpBlindFor(state, 'cat', 'timer')
		state = finish(state, { ann: '1', bob: '2' })
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect([...runOf(state).finishedPvpBlinds[0].losers].sort()).toEqual([
			'ann',
			'cat',
		])
		expect(livesOf(state, 'cat')).toBe(3)
		expect(livesOf(state, 'ann')).toBe(3)
		expect(livesOf(state, 'bob')).toBe(4)
	})

	it('Teams: a timed player of the winning team costs that team a life', () => {
		const teams = { ann: 'A', bob: 'A', cat: 'B', dan: 'B' } as const
		const scores = { ann: '9', bob: '8', cat: '1', dan: '1' }
		const before = enterAll(
			open(withTeamLives(runInMode(FOUR, 'teams', teams)), FOUR),
			scores,
		)
		let state = endPvpBlindFor(before, 'ann', 'timer')
		state = finish(state, { bob: '8', cat: '1', dan: '1' })
		const lives = runOf(state).teamLives
		const start = runOf(before).teamLives
		expect(runOf(state).currentPvpBlind).toBeNull()
		expect(lives?.A).toBe((start?.A ?? 0) - 1)
		expect(lives?.B).toBe((start?.B ?? 0) - 1)
	})
})

describe("a Ready press for a Boss that is not the player's own (443)", () => {
	it('is refused wrong_blind and leaves no mark', () => {
		const pressed = ready(fourPlayers(), 'ann', true, '3:Boss')
		expect(pressed.refusals).toEqual(['wrong_blind'])
		expect(runOf(pressed.state).ready).toEqual({})
	})
})

describe('the pressure countdown while the player is Ready', () => {
	const withPressure = (): State => {
		const state = fourPlayers()
		const run = runOf(state)
		return {
			...state,
			run: {
				...run,
				clocks: {
					...run.clocks,
					countdowns: [
						{
							kind: 'personal',
							rate: 1,
							by: null,
							against: ['ann'],
							endsAt: 50_000,
							hold: { kind: 'counting' },
						},
					],
				},
			},
		}
	}

	it('stops while Ready, and stays stopped when Ready is taken back (460)', () => {
		const pressed = ready(withPressure(), 'ann', true, BOSS, 1000).state
		expect(countdownsOf(pressed)[0].hold).toEqual({
			kind: 'paused until timed',
			sinceAt: 1000,
		})
		const taken = ready(pressed, 'ann', false, BOSS, 4000).state
		expect(countdownsOf(taken)[0].hold).toEqual({
			kind: 'paused until timed',
			sinceAt: 1000,
		})
		expect(countdownsOf(taken)[0].endsAt).toBe(50_000)
	})

	it('runs again only while an Ante countdown times the player who is not Ready (460)', () => {
		const taken = ready(
			ready(withPressure(), 'ann', true, BOSS, 1000).state,
			'ann',
			false,
			BOSS,
			4000,
		).state
		const bobReady = ready(taken, 'bob', true, BOSS, 5000).state
		const timed = start(bobReady, 'bob', 'ante', 6000).state
		const [pressure] = countdownsOf(timed).filter(
			(countdown) => countdown.kind === 'personal',
		)
		expect(pressure.hold).toEqual({ kind: 'counting' })
		expect(pressure.endsAt).toBe(55_000)
	})

	it('stops again when the starter pauses the Ante countdown (main clears the timer flag)', () => {
		const taken = ready(
			ready(withPressure(), 'ann', true, BOSS, 1000).state,
			'ann',
			false,
			BOSS,
			4000,
		).state
		const timed = start(
			ready(taken, 'bob', true, BOSS, 5000).state,
			'bob',
			'ante',
			6000,
		).state
		const paused = send(timed, 'bob', { kind: 'timerPause' }, 9000).state
		const [pressure] = countdownsOf(paused).filter(
			(countdown) => countdown.kind === 'personal',
		)
		expect(pressure.hold).toEqual({ kind: 'paused until timed', sinceAt: 9000 })
	})
})

type Kind =
	| 'progress'
	| 'ready'
	| 'unready'
	| 'left'
	| 'forfeit'
	| 'startTimer'
	| 'pvpTimer'
	| 'runOut'
	| 'beaten'
	| 'lost'
	| 'skip'
	| 'away'
	| 'back'
	| 'hand'
	| 'score'
	| 'finish'

interface Step {
	kind: Kind
	seat: number
	ante: number
	blind: 'Small' | 'Boss'
	score: number
	hands: number
}

const stepArbitrary: fc.Arbitrary<Step> = fc.record({
	kind: fc.constantFrom<Kind>(
		'progress',
		'ready',
		'ready',
		'ready',
		'ready',
		'unready',
		'left',
		'forfeit',
		'startTimer',
		'pvpTimer',
		'pvpTimer',
		'runOut',
		'runOut',
		'beaten',
		'lost',
		'skip',
		'away',
		'back',
		'hand',
		'score',
		'finish',
		'finish',
	),
	seat: fc.nat({ max: NAMES.length - 1 }),
	ante: fc.constantFrom(2, 2, 2, 3),
	blind: fc.constantFrom<'Small' | 'Boss'>('Small', 'Boss', 'Boss'),
	score: fc.nat({ max: 9 }),
	hands: fc.integer({ min: 1, max: 3 }),
})

type Setup = 'duel' | 'royale' | 'nemesis' | 'teams'

const startArbitrary: fc.Arbitrary<{ setup: Setup; count: number }> = fc
	.constantFrom<Setup>('duel', 'royale', 'nemesis', 'nemesis', 'teams')
	.chain((setup) =>
		fc
			.integer(
				setup === 'duel'
					? { min: 2, max: 2 }
					: setup === 'teams'
						? { min: 4, max: 4 }
						: { min: 3, max: 5 },
			)
			.map((count) => ({ setup, count })),
	)

function startRun(setup: Setup, players: PlayerId[]): State {
	if (setup === 'nemesis') return pairedRun(players, partnersOf(players))
	const mode = setup === 'duel' ? 'nemesis' : setup
	const picked = runInMode(
		players,
		mode,
		setup === 'teams' ? { ann: 'A', bob: 'A', cat: 'B', dan: 'B' } : {},
	)
	return players.reduce(
		(next, player) => progress(next, player, 2),
		setup === 'teams' ? withTeamLives(picked) : picked,
	)
}

// One PvP blind input of a player in the PvP blind being played: enter, play a hand, score, or end.
function playPvpBlind(
	state: State,
	player: PlayerId,
	kind: 'hand' | 'score' | 'finish',
	step: Step,
	now: number,
): State {
	const currentPvpBlind = runOf(state).currentPvpBlind
	const own = currentPvpBlind?.players[player]
	if (currentPvpBlind === null || own === undefined || own.stage === 'done')
		return state
	const { blindKey } = currentPvpBlind
	if (own.stage === 'not entered')
		return send(
			state,
			player,
			{
				kind: 'blindStart',
				blindKey,
				handsLeft: step.hands,
				score: String(step.score),
			},
			now,
		).state
	const score = String(Number(own.score) + step.score)
	const body =
		kind === 'hand'
			? {
					kind: 'handPlayed',
					blindKey,
					handsLeft: Math.max(own.handsLeft - 1, 0),
				}
			: {
					kind: 'handScored',
					blindKey,
					handsLeft: kind === 'finish' ? 0 : own.handsLeft,
					score,
				}
	return send(state, player, body, now).state
}

describe('one PvP blind for everyone, whatever the players do', () => {
	it('never sticks, charges only what a closed PvP blind or a run-out names, and the view agrees with Ready', () => {
		fc.assert(
			fc.property(
				startArbitrary,
				fc.array(stepArbitrary, { maxLength: 40 }),
				({ setup, count }, steps) => {
					const players = NAMES.slice(0, count)
					let state = startRun(setup, players)
					let now = 0
					const away = new Set<PlayerId>()
					for (const step of steps) {
						const { kind, seat, ante, blind } = step
						const player = players[seat % count]
						const before = runOf(state)
						now += 1
						const ownAnte = before.players[player]?.ante ?? ante
						if (kind === 'progress') state = progress(state, player, ante)
						else if (kind === 'ready')
							state = ready(state, player, true, `${ownAnte}:Boss`, now).state
						else if (kind === 'unready')
							state = ready(state, player, false, `${ownAnte}:Boss`, now).state
						else if (kind === 'startTimer')
							state = start(state, player, 'ante', now).state
						else if (kind === 'pvpTimer')
							state = start(state, player, 'pvp', now).state
						else if (kind === 'runOut') {
							now += HOUR
							state = tick(state, now, { ranked: true })
						} else if (kind === 'beaten' || kind === 'lost')
							state = send(
								state,
								player,
								{
									kind: 'blindResult',
									blindKey: `${ownAnte}:${blind}`,
									result: kind,
								},
								now,
							).state
						else if (kind === 'skip')
							state = send(
								state,
								player,
								{ kind: 'skip', blindKey: `${ownAnte}:Small`, total: 1 },
								now,
							).state
						else if (kind === 'away' || kind === 'back') {
							if (kind === 'away') away.add(player)
							else away.delete(player)
							state = shellTick(state, now, facts([...away]))
						} else if (kind === 'hand' || kind === 'score' || kind === 'finish')
							state = playPvpBlind(state, player, kind, step, now)
						else {
							away.delete(player)
							state = drop(state, player, kind, now)
						}

						const run = runOf(state)

						// No stuck state: everyone still in Ready for the same PvP Boss means
						// a PvP blind plays.
						const inRun = players.filter((who) => isInRun(run, who))
						const readyFor = new Set(inRun.map((who) => run.ready[who]))
						const [only] = [...readyFor]
						const stuck =
							run.currentPvpBlind === null &&
							inRun.length >= 2 &&
							readyFor.size === 1 &&
							only !== undefined &&
							isPvpBlind(run, only) &&
							!run.finishedPvpBlinds.some((done) => done.blindKey === only)
						expect(stuck).toBe(false)

						// A playing PvP blind whose required players are all done is closed by
						// the tick, unless the match is decided.
						if (run.currentPvpBlind !== null) {
							const ticked = tick(state, now, { ranked: true })
							const next = ticked.run
							if (
								ticked.result === null &&
								next !== null &&
								next.currentPvpBlind !== null
							)
								expect(
									requiredPlayers(next).every(
										(who) =>
											next.currentPvpBlind?.players[who]?.stage === 'done',
									),
								).toBe(false)
						}

						// A closed PvP blind costs each player (or team pool) at most one life,
						// and only a player (or team) it names as a loser.
						if (
							run.finishedPvpBlinds.length > before.finishedPvpBlinds.length &&
							kind !== 'left' &&
							kind !== 'forfeit'
						) {
							const { losers } =
								run.finishedPvpBlinds[run.finishedPvpBlinds.length - 1]
							if (setup === 'teams') {
								for (const side of ['A', 'B'] as const) {
									const lost =
										(before.teamLives?.[side] ?? 0) -
										(run.teamLives?.[side] ?? 0)
									expect(lost).toBeLessThanOrEqual(1)
									if (lost > 0)
										expect(
											losers.some((who) => state.players[who]?.team === side),
										).toBe(true)
								}
							} else
								for (const who of players) {
									const lost = before.lives[who].lives - run.lives[who].lives
									expect(lost).toBeLessThanOrEqual(1)
									if (lost > 0) expect(losers).toContain(who)
								}
						}

						// An Ante run-out costs a player timed by it at most one life, and
						// nobody it did not time; in Teams a pool drops by at most the
						// timed players of that team.
						if (kind === 'runOut' && before.currentPvpBlind === null) {
							const timed = new Set(
								before.clocks.countdowns.flatMap((countdown) =>
									countdown.kind === 'ante' && isCounting(countdown)
										? countdown.against
										: [],
								),
							)
							const anteBosses = new Set(
								before.clocks.countdowns.flatMap((countdown) =>
									countdown.kind === 'ante' && countdown.blindKey !== undefined
										? [countdown.blindKey]
										: [],
								),
							)
							if (setup === 'teams')
								for (const side of ['A', 'B'] as const) {
									const timedOnSide = [...timed].filter(
										(who) => state.players[who]?.team === side,
									).length
									expect(
										(before.teamLives?.[side] ?? 0) -
											(run.teamLives?.[side] ?? 0),
									).toBeLessThanOrEqual(timedOnSide)
								}
							else
								for (const who of players) {
									const lost = before.lives[who].lives - run.lives[who].lives
									expect(lost).toBeLessThanOrEqual(1)
									if (!timed.has(who)) expect(lost).toBe(0)
									// A player Ready for the countdown's own Boss is never charged.
									const readyForBoss = before.ready[who]
									if (
										anteBosses.size === 1 &&
										readyForBoss !== undefined &&
										anteBosses.has(readyForBoss)
									)
										expect(lost).toBe(0)
								}
						}

						// The Ready button in the view is the Ready press the server takes.
						for (const who of players) {
							const own = run.players[who]?.ante ?? null
							if (own === null || !isInRun(run, who)) continue
							const blindKey = `${own}:Boss`
							if (
								run.finishedPvpBlinds.some((done) => done.blindKey === blindKey)
							)
								continue
							if (run.currentPvpBlind !== null) continue
							// A decided match takes no Ready press, whatever the button says.
							if (state.result !== null) continue
							if (run.players[who].results[blindKey] !== undefined) continue
							expect(targetsOf(state, who).myBoss !== 'no pvp this ante').toBe(
								pressAccepted(state, who),
							)
						}
					}
				},
			),
			{ numRuns: 1500 },
		)
	})
})
