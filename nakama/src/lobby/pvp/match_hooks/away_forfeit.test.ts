// A player away in a PvP run spends one away budget for the whole run; when it is spent, they
// lose the game. Everything outside a run keeps the lobby's grace of one drop.
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkpointOf, resumeFrom } from '../../checkpoint'
import {
	type Lobby,
	type Outbound,
	disconnect,
	join,
	snapshotFor,
	tick,
} from '../../state'
import { startCountdown, timeLeft } from '../core/clock'
import { view } from '../core/view'
import { LIMITS } from '../testing/state'
import { CONFIG, NOW, lobbyOf, matchOf, started } from '../testing/lobbies'
import { factsOf, pvpHooks } from './pvp_shell'

const BUDGET = LIMITS.awayBudgetMilliseconds
const SECOND = 1000

const inRun = (): Lobby => {
	const lobby = lobbyOf()
	return { ...lobby, game: { ...lobby.game, pvp: started(lobby) } }
}

// What the match loop does every tick: the lobby's clock, then the PvP part.
const loop = (lobby: Lobby, now: number): Lobby =>
	pvpHooks.onTick(tick(lobby, now).lobby, now)

const drop = (lobby: Lobby, now: number): Lobby =>
	loop(disconnect(lobby, 'bob', 'bob-s1', now).lobby, now)

const back = (lobby: Lobby, now: number, player = 'bob'): Lobby =>
	loop(
		{
			...lobby,
			players: lobby.players.map((p) =>
				p.id === player ? { ...p, awaySince: null } : p,
			),
		},
		now,
	)

const seated = (lobby: Lobby): boolean =>
	lobby.players.some((p) => p.id === 'bob')

const forfeitsAtOf = (
	lobby: Lobby,
	player: string,
	viewer: string,
	now: number,
): number | null =>
	snapshotFor(lobby, viewer, now).players.find((p) => p.id === player)
		?.forfeitsAt ?? null

const bobForfeitsAt = (lobby: Lobby, now: number): number | null =>
	forfeitsAtOf(lobby, 'bob', 'ann', now)

// The forfeitsAt that the player_disconnected event carries.
function eventForfeitsAt(out: Outbound[]): number | null {
	for (const one of out) {
		if (one.kind !== 'send' || !('payload' in one)) continue
		const payload: unknown = one.payload
		if (
			typeof payload === 'object' &&
			payload !== null &&
			'type' in payload &&
			payload.type === 'player_disconnected' &&
			'data' in payload &&
			typeof payload.data === 'object' &&
			payload.data !== null &&
			'forfeitsAt' in payload.data &&
			typeof payload.data.forfeitsAt === 'number'
		)
			return payload.data.forfeitsAt
	}
	return null
}

// The end of the grace the view of `viewer` shows.
function viewGraceEndsAt(
	lobby: Lobby,
	viewer: string,
	now: number,
): number | null {
	const pvp = lobby.game.pvp
	if (pvp === undefined) return null
	const shown = view(pvp, viewer, now, factsOf(lobby))
	return shown?.timers.deadlines.find((d) => d.kind === 'grace')?.endsAt ?? null
}

// Seconds from `from` to `to`, one loop each.
function stay(lobby: Lobby, from: number, to: number): Lobby {
	let current = lobby
	for (let now = from + SECOND; now <= to; now += SECOND)
		current = loop(current, now)
	return current
}

describe('away in a PvP run', () => {
	it('one drop shorter than the budget does not forfeit', () => {
		const at = NOW + SECOND
		const away = stay(drop(inRun(), at), at, at + BUDGET - SECOND)
		expect(seated(away)).toBe(true)
		expect(away.game.pvp?.result).toBeNull()
	})

	it('two drops forfeit when their away time adds up to the budget', () => {
		const firstAway = 70 * SECOND
		const first = NOW + SECOND
		let lobby = stay(drop(inRun(), first), first, first + firstAway)
		expect(seated(lobby)).toBe(true)
		const backAt = first + firstAway
		lobby = back(lobby, backAt)
		const second = backAt + 10 * SECOND
		lobby = stay(
			drop(lobby, second),
			second,
			second + BUDGET - firstAway - SECOND,
		)
		expect(seated(lobby)).toBe(true)
		lobby = loop(lobby, second + BUDGET - firstAway)
		expect(seated(lobby)).toBe(false)
		expect(lobby.forfeitedSeats).toEqual({ bob: 'run-1' })
		expect(lobby.game.pvp?.result).toMatchObject({
			kind: 'win',
			winners: ['ann'],
		})
	})

	it('a player back before the budget is spent keeps the seat', () => {
		const at = NOW + SECOND
		const away = stay(drop(inRun(), at), at, at + BUDGET - SECOND)
		const returned = back(away, at + BUDGET - SECOND)
		expect(
			seated(stay(returned, at + BUDGET - SECOND, at + 900 * SECOND)),
		).toBe(true)
	})

	it('the forfeitsAt of the snapshot and of the event is the moment they forfeit, after a second drop too', () => {
		const first = NOW + SECOND
		const away = disconnect(inRun(), 'bob', 'bob-s1', first)
		const event = away.out.flatMap((out) =>
			out.kind === 'send' && 'payload' in out ? [out.payload] : [],
		)
		expect(JSON.stringify(event)).toContain(String(first + BUDGET))
		let lobby = loop(away.lobby, first)
		expect(bobForfeitsAt(lobby, first)).toBe(first + BUDGET)
		lobby = back(stay(lobby, first, first + 100 * SECOND), first + 100 * SECOND)
		expect(bobForfeitsAt(lobby, first + 100 * SECOND)).toBeNull()
		const second = first + 150 * SECOND
		const secondAway = disconnect(lobby, 'bob', 'bob-s1', second)
		expect(JSON.stringify(secondAway.out)).toContain(
			String(second + BUDGET - 100 * SECOND),
		)
		lobby = loop(secondAway.lobby, second)
		const moment = bobForfeitsAt(lobby, second)
		expect(moment).toBe(second + BUDGET - 100 * SECOND)
		lobby = stay(lobby, second, (moment ?? 0) - SECOND)
		expect(seated(lobby)).toBe(true)
		expect(seated(loop(lobby, moment ?? 0))).toBe(false)
	})

	it('the first loop 200 ms after the drop: event, forfeiting tick, snapshot and view agree', () => {
		const at = NOW + SECOND
		const dropped = disconnect(inRun(), 'bob', 'bob-s1', at)
		const moment = at + BUDGET
		expect(eventForfeitsAt(dropped.out)).toBe(moment)
		const lobby = loop(dropped.lobby, at + 200)
		expect(bobForfeitsAt(lobby, at + 200)).toBe(moment)
		expect(viewGraceEndsAt(lobby, 'ann', at + 200)).toBe(moment)
		const late = stay(lobby, at + 200, moment - SECOND)
		expect(seated(loop(late, moment - 1))).toBe(true)
		expect(seated(loop(late, moment))).toBe(false)
	})

	it('a first drop seen 200 ms late is charged from the drop: the second drop forfeits on time', () => {
		const first = NOW + SECOND
		let lobby = loop(
			disconnect(inRun(), 'bob', 'bob-s1', first).lobby,
			first + 200,
		)
		lobby = back(lobby, first + 100 * SECOND)
		const second = first + 150 * SECOND
		const moment = second + BUDGET - 100 * SECOND
		const dropped = disconnect(lobby, 'bob', 'bob-s1', second)
		expect(eventForfeitsAt(dropped.out)).toBe(moment)
		lobby = loop(dropped.lobby, second + 200)
		expect(bobForfeitsAt(lobby, second + 200)).toBe(moment)
		expect(viewGraceEndsAt(lobby, 'ann', second + 200)).toBe(moment)
		expect(seated(loop(lobby, moment - 1))).toBe(true)
		expect(seated(loop(lobby, moment))).toBe(false)
	})

	it('no countdown runs and no life is lost while a player is away', () => {
		const lobby = inRun()
		const pvp = lobby.game.pvp
		const run = pvp?.run
		if (pvp === undefined || run === null || run === undefined)
			throw new Error('no run')
		const clocks = startCountdown(
			run.clocks,
			{
				kind: 'personal',
				by: 'bob',
				against: ['bob'],
				lengthMilliseconds: 100 * SECOND,
			},
			NOW,
		)
		const withTimer: Lobby = {
			...lobby,
			game: { ...lobby.game, pvp: { ...pvp, run: { ...run, clocks } } },
		}
		const at = NOW + SECOND
		const away = stay(drop(withTimer, at), at, at + BUDGET - SECOND)
		const during = away.game.pvp?.run
		const timer = during?.clocks.countdowns[0]
		if (during === undefined || during === null || timer === undefined)
			throw new Error('no timer')
		expect(during.lives).toEqual(run.lives)
		expect(timer.hold.kind).toBe('held for player')
		expect(timeLeft(timer, at + BUDGET - SECOND)).toBe(
			timeLeft(clocks.countdowns[0], at),
		)
	})

	it('property: forfeits exactly when the away time of all the drops reaches the budget', () => {
		const drops = fc.array(
			fc.record({
				gap: fc.integer({ min: 1, max: 100 }),
				away: fc.integer({ min: 1, max: 200 }),
			}),
			{ minLength: 1, maxLength: 5 },
		)
		fc.assert(
			fc.property(drops, (list) => {
				let lobby = inRun()
				let now = NOW
				let spent = 0
				for (const one of list) {
					now += one.gap * SECOND
					lobby = drop(lobby, now)
					for (let sec = 1; sec <= one.away; sec++) {
						now += SECOND
						spent += SECOND
						lobby = loop(lobby, now)
						expect(seated(lobby)).toBe(spent < BUDGET)
					}
					if (!seated(lobby)) return
					lobby = back(lobby, now)
				}
			}),
			{ numRuns: 40 },
		)
	})
})

describe('away and back through a rejoin', () => {
	// The game comes back on a new session, as the match does it: the lobby's join, then the
	// PvP join hook, then the next tick.
	const rejoin = (lobby: Lobby, now: number, session: string): Lobby => {
		const bob = lobby.players.find((p) => p.id === 'bob')
		if (bob === undefined) throw new Error('bob left')
		const joined = join(lobby, 'bob', session, bob.info, now).lobby
		const handed = pvpHooks.onJoin(
			joined,
			{ playerId: 'bob', joinKeys: {} },
			now,
		)
		if ('reject' in handed) throw new Error(handed.reject)
		return loop(handed.lobby, now)
	}

	it('the second drop starts from the away time the first one left', () => {
		const firstAway = 70 * SECOND
		const first = NOW + SECOND
		let lobby = stay(drop(inRun(), first), first, first + firstAway)
		lobby = rejoin(lobby, first + firstAway, 'bob-s2')
		expect(bobForfeitsAt(lobby, first + firstAway)).toBeNull()
		const second = first + firstAway + 10 * SECOND
		lobby = stay(lobby, first + firstAway, second)
		lobby = loop(disconnect(lobby, 'bob', 'bob-s2', second).lobby, second)
		const moment = second + BUDGET - firstAway
		expect(bobForfeitsAt(lobby, second)).toBe(moment)
		lobby = stay(lobby, second, moment - SECOND)
		expect(seated(lobby)).toBe(true)
		expect(seated(loop(lobby, moment))).toBe(false)
	})
})

describe('away across a server restart', () => {
	const DOWNTIME = 200 * SECOND

	// The lobby after a restart: stopped at `stoppedAt`, resumed `DOWNTIME` later.
	const restarted = (lobby: Lobby, stoppedAt: number): Lobby => {
		const checkpoint = checkpointOf(lobby, stoppedAt)
		if (checkpoint === null) throw new Error('no checkpoint')
		return resumeFrom(checkpoint, stoppedAt + DOWNTIME)
	}

	it('a player who dropped before the restart keeps the away time they had left, moved on by the downtime', () => {
		const at = NOW + SECOND
		const stoppedAt = at + 60 * SECOND
		const before = stay(drop(inRun(), at), at, stoppedAt)
		expect(bobForfeitsAt(before, stoppedAt)).toBe(at + BUDGET)
		const resumedAt = stoppedAt + DOWNTIME
		const after = restarted(before, stoppedAt)
		const moment = at + BUDGET + DOWNTIME
		expect(bobForfeitsAt(after, resumedAt)).toBe(moment)
		expect(viewGraceEndsAt(after, 'ann', resumedAt)).toBe(moment)
		const annBack = back(after, resumedAt, 'ann')
		const waiting = stay(annBack, resumedAt, moment - SECOND)
		expect(seated(loop(waiting, moment - 1))).toBe(true)
		expect(seated(loop(waiting, moment))).toBe(false)
	})

	it('a player who was playing gets the lobby grace from the resume and spends no away time', () => {
		const stoppedAt = NOW + 60 * SECOND
		const resumedAt = stoppedAt + DOWNTIME
		const after = loop(restarted(inRun(), stoppedAt), resumedAt)
		expect(forfeitsAtOf(after, 'ann', 'bob', resumedAt)).toBe(
			resumedAt + 120 * SECOND,
		)
		const waiting = stay(after, resumedAt, resumedAt + 100 * SECOND)
		expect(waiting.game.pvp?.run?.clocks.players.ann.awayLeftMilliseconds).toBe(
			BUDGET,
		)
		expect(forfeitsAtOf(waiting, 'ann', 'bob', resumedAt + 100 * SECOND)).toBe(
			resumedAt + 120 * SECOND,
		)
		expect(seated(tick(waiting, resumedAt + 119_999).lobby)).toBe(true)
		expect(
			tick(waiting, resumedAt + 120_000).lobby.players.some(
				(q) => q.id === 'ann',
			),
		).toBe(false)
	})

	it('a player who comes back after a restart keeps the whole away budget', () => {
		const stoppedAt = NOW + 60 * SECOND
		const resumedAt = stoppedAt + DOWNTIME
		const waiting = stay(
			loop(restarted(inRun(), stoppedAt), resumedAt),
			resumedAt,
			resumedAt + 100 * SECOND,
		)
		const clocks = waiting.game.pvp?.run?.clocks
		expect(clocks?.players.bob.awayLeftMilliseconds).toBe(BUDGET)
		expect(clocks?.playerPauses.map((pause) => pause.reason)).toEqual([
			'server restart',
			'server restart',
		])
	})
})

describe('away outside a PvP run', () => {
	const noRun = (): Lobby => matchOf(lobbyOf())

	it('keeps the grace of 120 s for each drop', () => {
		const at = NOW
		const away = disconnect(noRun(), 'bob', 'bob-s1', at).lobby
		expect(seated(tick(away, at + 119_999).lobby)).toBe(true)
		expect(seated(tick(away, at + 120_000).lobby)).toBe(false)
		expect(bobForfeitsAt(away, at)).toBe(at + 120_000)
	})

	it('a lobby with no match keeps it too', () => {
		const away = disconnect(lobbyOf(), 'bob', 'bob-s1', NOW).lobby
		expect(bobForfeitsAt(away, NOW)).toBe(NOW + 120_000)
	})
})
