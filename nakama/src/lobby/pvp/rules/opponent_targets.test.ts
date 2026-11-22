import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { MyBoss, PlayerId, State } from '../core/types'
import { runOutTimers } from '../inputs/timer_run_out'
import { ready, runOf, send } from '../testing/inputs'
import { pairedRun, runInMode, runState } from '../testing/state'
import { inPvpBlind, pvpStarted } from '../testing/timers'
import { targetsOf } from './opponent_targets'
import { isInRun } from './players'

type Out = 'eliminated' | 'forfeited'

function markOut(state: State, player: PlayerId, how: Out): State {
	const run = state.run
	if (run === null) throw new Error('no run')
	return {
		...state,
		run: {
			...run,
			lives: {
				...run.lives,
				[player]: {
					...run.lives[player],
					status: how === 'eliminated' ? 'out' : 'forfeited',
				},
			},
		},
	}
}

const FOUR = ['ann', 'bob', 'cat', 'dan']
const THREE = ['ann', 'bob', 'cat']

function teamsRun(): State {
	const base = runInMode(FOUR, 'teams', {
		ann: 'A',
		bob: 'A',
		cat: 'B',
		dan: 'B',
	})
	return {
		...base,
		run: {
			...(base.run as NonNullable<State['run']>),
			cardTargets: {
				ante: 2,
				targets: { ann: 'cat', bob: 'dan', cat: 'ann', dan: 'bob' },
			},
		},
	}
}

function manhuntRun(): State {
	return runInMode(THREE, 'manhunt', {
		ann: 'RUNNER',
		bob: 'HUNTER',
		cat: 'HUNTER',
	})
}

const duel = () => pairedRun(['ann', 'bob'], { ann: 'bob', bob: 'ann' })
const nemesisWithBye = () =>
	pairedRun(THREE, { ann: 'bob', bob: 'ann', cat: null })

describe('who is in the run', () => {
	it('a player out of the run is not in it', () => {
		const state = markOut(
			markOut(runState(THREE), 'bob', 'eliminated'),
			'cat',
			'forfeited',
		)
		const run = state.run as NonNullable<State['run']>
		expect([
			isInRun(run, 'ann'),
			isInRun(run, 'bob'),
			isInRun(run, 'cat'),
		]).toEqual([true, false, false])
		expect(isInRun(run, 'nobody')).toBe(false)
	})
})

describe('the ante a pairing is for', () => {
	it.each<[string, () => State, number | null]>([
		['nemesis, paired', nemesisWithBye, 2],
		['a duel, which has no pairing', duel, null],
		['teams, with card targets', teamsRun, 2],
		['teams, before any', () => runInMode(FOUR, 'teams'), null],
		['nemesis, before any', () => runInMode(THREE, 'nemesis'), null],
		['royale, which pairs nobody', () => runInMode(FOUR, 'royale'), null],
	])('%s: %s', (_name, make, ante) => {
		expect(targetsOf(make(), 'ann').pairingAnte).toBe(ante)
	})
})

function onAnte(state: State, player: PlayerId, ante: number | null): State {
	const run = state.run as NonNullable<State['run']>
	return {
		...state,
		run: {
			...run,
			players: { ...run.players, [player]: { ...run.players[player], ante } },
		},
	}
}

describe('which Boss the viewer plays this ante', () => {
	const noPartner = (): State => onAnte(nemesisWithBye(), 'cat', 2)

	it.each<[string, () => State, PlayerId, MyBoss]>([
		['no partner in this ante pairing', noPartner, 'cat', 'bye'],
		[
			'a partner in this ante pairing',
			() => onAnte(nemesisWithBye(), 'ann', 2),
			'ann',
			'plays',
		],
		[
			'a partner eliminated after the pairing is no partner',
			() => markOut(onAnte(nemesisWithBye(), 'ann', 2), 'bob', 'eliminated'),
			'ann',
			'bye',
		],
		[
			'a partner forfeited after the pairing is no partner',
			() => markOut(onAnte(nemesisWithBye(), 'ann', 2), 'bob', 'forfeited'),
			'ann',
			'bye',
		],
		[
			'the ante the viewer is on is not paired yet',
			() => onAnte(nemesisWithBye(), 'cat', 3),
			'cat',
			'plays',
		],
		[
			'the viewer has reported no ante',
			() => onAnte(nemesisWithBye(), 'cat', null),
			'cat',
			'no pvp this ante',
		],
		[
			'ante 1 has no PvP Boss',
			() => onAnte(runInMode(THREE, 'nemesis'), 'ann', 1),
			'ann',
			'no pvp this ante',
		],
		[
			'a 2-player nemesis',
			() =>
				onAnte(pairedRun(['ann', 'bob'], { ann: 'bob', bob: 'ann' }), 'ann', 2),
			'ann',
			'plays',
		],
		['a duel at its first PvP Boss', duel, 'ann', 'plays'],
		['royale', () => runInMode(FOUR, 'royale'), 'ann', 'no pvp this ante'],
		['manhunt', manhuntRun, 'bob', 'no pvp this ante'],
		['teams', teamsRun, 'ann', 'no pvp this ante'],
	])('%s: myBoss is %s', (_name, make, viewer, myBoss) => {
		expect(targetsOf(make(), viewer).myBoss).toBe(myBoss)
	})

	it('a partner who is out leaves no opponent and the bye', () => {
		const state = markOut(
			onAnte(nemesisWithBye(), 'ann', 2),
			'bob',
			'eliminated',
		)
		const targets = targetsOf(state, 'ann')
		expect(targets.opponents).toEqual([])
		expect(targets.myBoss).toBe('bye')
	})

	it('a duel before any progress has no PvP this ante', () => {
		expect(targetsOf(runState(['ann', 'bob']), 'ann').myBoss).toBe(
			'no pvp this ante',
		)
	})

	it('a run of 3 or more before any progress has no PvP this ante', () => {
		expect(
			targetsOf(onAnte(runInMode(THREE, 'nemesis'), 'ann', null), 'ann').myBoss,
		).toBe('no pvp this ante')
	})
})

describe('where the viewer stands against the cut', () => {
	const ofLastTwo = (): State => {
		const base = runInMode(THREE, 'royale')
		return markOut(base, 'cat', 'forfeited')
	}
	const lastTwoStillIn = (): State => {
		const base = runInMode(THREE, 'royale')
		const run = base.run as NonNullable<State['run']>
		return {
			...base,
			run: {
				...run,
				lives: { ...run.lives, cat: { ...run.lives.cat, status: 'left' } },
			},
		}
	}

	it.each<[string, () => State, 'above the cut' | 'below the cut' | 'no cut']>([
		['a duel', duel, 'no cut'],
		[
			'royale with three players',
			() => runInMode(THREE, 'royale'),
			'below the cut',
		],
		['royale with its last two', lastTwoStillIn, 'no cut'],
		[
			'royale with one out of lives but still in the lobby',
			ofLastTwo,
			'below the cut',
		],
		['nemesis', nemesisWithBye, 'no cut'],
		['teams', teamsRun, 'no cut'],
		['manhunt', manhuntRun, 'no cut'],
	])('%s: cut is %s', (_name, make, cut) => {
		expect(targetsOf(make(), 'ann').cut).toBe(cut)
	})

	it('a player no longer ranked has no cut', () => {
		expect(
			targetsOf(markOut(runInMode(THREE, 'royale'), 'ann', 'eliminated'), 'ann')
				.cut,
		).toBe('no cut')
	})
})

const BLIND_2 = '2:Boss'

function progress(state: State, player: PlayerId, ante: number): State {
	return send(state, player, { kind: 'progress', ante, location: 'shop' }).state
}

function nemesisRun(players: PlayerId[], runId: string): State {
	const base = runInMode(players, 'nemesis')
	return { ...base, run: { ...runOf(base), id: runId } }
}

// Every player has reported `ante`, so that ante is paired.
function allAt(state: State, ante: number): State {
	return Object.keys(runOf(state).lives).reduce(
		(next, player) => progress(next, player, ante),
		state,
	)
}

function byePlayerOf(state: State, ante: number): PlayerId {
	const partners = runOf(state).pairings[ante].partners
	const bye = Object.keys(partners).find((player) => partners[player] === null)
	if (bye === undefined) throw new Error('no bye')
	return bye
}

describe('the pairing of one ante is never changed by the next ante', () => {
	it('the PvP blind holds everyone, the partners are compared and the bye is not', () => {
		const state = THREE.reduce(
			(next, player) => ready(next, player, true, BLIND_2).state,
			allAt(nemesisRun(THREE, 'run-one'), 2),
		)
		const bye = byePlayerOf(state, 2)
		const currentPvpBlind = runOf(state).currentPvpBlind
		expect(Object.keys(currentPvpBlind?.players ?? {}).sort()).toEqual(THREE)
		expect(currentPvpBlind?.blindKey).toBe(BLIND_2)
		expect(targetsOf(state, bye).myBoss).toBe('bye')
		expect(targetsOf(state, bye).opponents).toEqual([])
		for (const player of THREE.filter((who) => who !== bye)) {
			const targets = targetsOf(state, player)
			expect(targets.myBoss).toBe('plays')
			expect(targets.pairingAnte).toBe(2)
			expect(targets.opponents).toHaveLength(1)
			expect(targets.opponents).not.toContain(bye)
		}
	})

	it('the player who is ahead reads the answer of their own ante', () => {
		const paired = allAt(nemesisRun(THREE, 'run-two'), 2)
		const bye = byePlayerOf(paired, 2)
		const ahead = progress(paired, bye, 3)
		const next = runOf(ahead).pairings[3]
		const targets = targetsOf(ahead, bye)
		expect(targets.pairingAnte).toBe(3)
		expect(targets.opponents).toEqual(
			next.partners[bye] === null ? [] : [next.partners[bye]],
		)
	})

	it('a player whose ante is not paired yet has no opponent', () => {
		const paired = allAt(nemesisRun(THREE, 'run-three'), 2)
		const behind = THREE.find((player) => player !== byePlayerOf(paired, 2))
		if (behind === undefined) throw new Error('no player')
		const ahead = progress(paired, behind, 4)
		const other = THREE.find((player) => player !== behind)
		if (other === undefined) throw new Error('no player')
		const skipped = {
			...ahead,
			run: {
				...runOf(ahead),
				players: {
					...runOf(ahead).players,
					[other]: { ...runOf(ahead).players[other], ante: 3 },
				},
			},
		}
		const targets = targetsOf(skipped, other)
		expect(targets.myBoss).toBe('plays')
		expect(targets.opponents).toEqual([])
		expect(targets.pairingAnte).toBeNull()
	})

	it('making the next pairing leaves the stored pairing of the ante as it was', () => {
		const paired = allAt(nemesisRun(THREE, 'run-four'), 2)
		const before = runOf(paired).pairings[2]
		const after = progress(paired, THREE[0], 3)
		expect(runOf(after).pairings[2]).toBe(before)
		expect(runOf(after).pairings[3]?.ante).toBe(3)
	})

	const answersOf = (state: State, viewer: PlayerId) => ({
		targets: targetsOf(state, viewer),
	})

	it('property: pairing the next ante changes no answer of a player still on this ante', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 7 }),
				fc.string({ minLength: 1, maxLength: 12 }),
				fc.nat(6),
				(count, runId, moverAt) => {
					const players = Array.from({ length: count }, (_, at) => `p${at}`)
					const before = allAt(nemesisRun(players, runId), 2)
					const mover = players[moverAt % count]
					const after = progress(before, mover, 3)
					expect(runOf(after).pairings[3]).toBeDefined()
					for (const viewer of players.filter((player) => player !== mover))
						expect(answersOf(after, viewer)).toEqual(answersOf(before, viewer))
				},
			),
		)
	})
})
