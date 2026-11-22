import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { PvpBlindResult, State } from '../core/types'
import { dropPlayer, settleWaitingDeaths } from '../inputs/finish'
import { copyOnRead } from '../testing/copy_on_read'
import { runOf, send } from '../testing/inputs'
import { pairedRun, runInMode, runState } from '../testing/state'
import { openWaitingDeath, recordExits, settleDeaths } from './deaths'
import { changeLedger, handleTimerRunOut } from './lives'
import { modeOf } from '../modes/index'

const KEY = '1:Small'

const withLives = (
	state: State,
	lives: { [player: string]: number },
): State => {
	const run = runOf(state)
	const seats = { ...run.lives }
	for (const player of Object.keys(lives))
		seats[player] = { ...seats[player], lives: lives[player] }
	return { ...state, run: { ...run, lives: seats } }
}

const answer = (
	state: State,
	player: string,
	beaten: boolean,
	blindKey = KEY,
): State =>
	send(state, player, {
		kind: 'blindResult',
		blindKey,
		result: beaten ? 'beaten' : 'lost',
	}).state
const settled = (state: State): State => settleWaitingDeaths(state, true)

const places = (state: State) => runOf(state).places
const waitingOn = (state: State) =>
	runOf(state).waitingDeaths.map((death) => ({
		player: death.playerId,
		waitingFor: death.waitingFor,
	}))

describe('a duel', () => {
	const dying = (): State =>
		answer(withLives(runState(['ann', 'bob']), { ann: 1 }), 'ann', false)

	it('opens a death that waits on the opponent', () => {
		const state = settled(dying())
		expect(waitingOn(state)).toEqual([{ player: 'ann', waitingFor: ['bob'] }])
		expect(state.result).toBeNull()
	})

	it.each([
		[
			'the opponent beats the blind',
			(s: State) => answer(s, 'bob', true),
			['bob'],
		],
		[
			'the opponent fails it with a life left',
			(s: State) => answer(s, 'bob', false),
			['bob'],
		],
		[
			'the opponent forfeits',
			(s: State) => send(s, 'bob', { kind: 'forfeit' }).state,
			['ann'],
		],
	])('%s: the match is won', (_name, step, winners) => {
		const state = settled(step(dying()))
		expect(state.result).toEqual({ kind: 'win', winners, rating: 'rated' })
		expect(waitingOn(state)).toEqual([])
		expect(places(state)).toEqual({
			ann: winners[0] === 'ann' ? 1 : 2,
			bob: winners[0] === 'bob' ? 1 : 2,
		})
	})

	it('is a draw when the opponent loses the last life on the same blind', () => {
		const state = settled(answer(withLives(dying(), { bob: 1 }), 'bob', false))
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
		expect(places(state)).toEqual({ ann: 1, bob: 1 })
	})

	it('a beaten blind wins over the opponent being out of lives', () => {
		const state = settled(answer(withLives(dying(), { bob: 0 }), 'bob', true))
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['bob'],
			rating: 'rated',
		})
	})

	it('a server run-out of the last life opens no death', () => {
		const start = withLives(runState(['ann', 'bob']), { ann: 1 })
		const run = runOf(start)
		const out = changeLedger(start, (before) =>
			handleTimerRunOut(before, modeOf(run), 'ann'),
		)
		expect(runOf(out).lives.ann.lives).toBe(0)
		expect(waitingOn(out)).toEqual([])
	})

	it('a lost PvP blind opens no death', () => {
		const start = withLives(runState(['ann', 'bob']), { ann: 1 })
		const run = runOf(start)
		const out = changeLedger(start, (before) =>
			openWaitingDeath(before, modeOf(run), 'ann', 'pvp:1'),
		)
		expect(waitingOn(out)).toEqual([])
	})
})

describe('Royale', () => {
	const three = (): State =>
		withLives(runInMode(['a', 'b', 'c'], 'royale'), { a: 1, b: 1 })

	it('a death closes once the others have answered the blind, and the game goes on', () => {
		const state = settled(
			answer(answer(answer(three(), 'a', false), 'b', true), 'c', true),
		)
		expect(waitingOn(state)).toEqual([])
		expect(state.result).toBeNull()
	})

	it('waits while a player has not answered', () => {
		const state = settled(answer(answer(three(), 'a', false), 'b', true))
		expect(waitingOn(state)).toEqual([{ player: 'a', waitingFor: ['c'] }])
	})

	it('ranks by who went out last, and the winner is the one left', () => {
		let state = answer(
			answer(answer(three(), 'a', false), 'b', true),
			'c',
			true,
		)
		state = settled(state)
		state = settled(
			answer(answer(state, 'b', false, '1:Big'), 'c', true, '1:Big'),
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['c'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ a: 3, b: 2, c: 1 })
	})

	it('players who lose their last life on the same blind share a place', () => {
		const state = settled(
			answer(answer(answer(three(), 'a', false), 'b', false), 'c', true),
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['c'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ a: 2, b: 2, c: 1 })
	})

	it('is a draw when everyone is out on the same blind', () => {
		const start = withLives(runInMode(['a', 'b', 'c'], 'royale'), {
			a: 1,
			b: 1,
			c: 1,
		})
		const state = settled(
			answer(answer(answer(start, 'a', false), 'b', false), 'c', false),
		)
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
		expect(places(state)).toEqual({ a: 1, b: 1, c: 1 })
	})

	it('a player who forfeits is out for the rest and counts as answered', () => {
		const start = settled(answer(three(), 'a', false))
		const state = settled(
			answer(send(start, 'c', { kind: 'forfeit' }).state, 'b', true),
		)
		expect(waitingOn(state)).toEqual([])
	})
})

describe('Teams', () => {
	const teams = { a: 'A', b: 'A', c: 'B', d: 'B' } as const
	const dying = (): State => {
		const base = runInMode(['a', 'b', 'c', 'd'], 'teams', teams)
		const run = runOf(base)
		return answer(
			{ ...base, run: { ...run, teamLives: { A: 1, B: 4 } } },
			'a',
			false,
		)
	}

	it('opens one death that waits on the other team', () => {
		expect(waitingOn(settled(dying()))).toEqual([
			{ player: 'a', waitingFor: ['c', 'd'] },
		])
	})

	it('the other team wins when one of its players beat the blind', () => {
		const state = settled(answer(answer(dying(), 'c', true), 'd', false))
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['c', 'd'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ a: 2, b: 2, c: 1, d: 1 })
	})

	it('is a draw when the other team failed it too', () => {
		const state = settled(answer(answer(dying(), 'c', false), 'd', false))
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
	})

	it('waits for the other team while it has players that have not answered', () => {
		const state = settled(answer(dying(), 'c', false))
		expect(state.result).toBeNull()
		expect(waitingOn(state)).toEqual([{ player: 'a', waitingFor: ['d'] }])
	})

	it('R6: the whole other team leaves without answering: the dead team wins', () => {
		const state = settled(
			dropPlayer(dropPlayer(dying(), 'c', 'left', 0), 'd', 'left', 0),
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['a', 'b'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ a: 1, b: 1, c: 2, d: 2 })
	})

	it('the other team forfeits without answering: the dead team wins', () => {
		const state = settled(
			send(send(dying(), 'c', { kind: 'forfeit' }).state, 'd', {
				kind: 'forfeit',
			}).state,
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['a', 'b'],
			rating: 'rated',
		})
	})

	it('one answered and failed, the other left: a draw', () => {
		const state = settled(
			dropPlayer(answer(dying(), 'c', false), 'd', 'left', 0),
		)
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
	})

	it('one left, the other has not answered: the death still waits for that one', () => {
		const state = settled(dropPlayer(dying(), 'c', 'left', 0))
		expect(state.result).toBeNull()
		expect(waitingOn(state)).toEqual([{ player: 'a', waitingFor: ['d'] }])
	})
})

describe('Manhunt', () => {
	const teams = { r: 'RUNNER', x: 'HUNTER', y: 'HUNTER' } as const
	const start = (): State =>
		withLives(runInMode(['r', 'x', 'y'], 'manhunt', teams), { r: 1, x: 1 })

	it('only the Runner opens a death', () => {
		expect(waitingOn(settled(answer(start(), 'x', false)))).toEqual([])
		expect(waitingOn(settled(answer(start(), 'r', false)))).toEqual([
			{ player: 'r', waitingFor: ['x', 'y'] },
		])
	})

	it("the Hunters win when one of them beat the Runner's blind", () => {
		const state = settled(
			answer(answer(answer(start(), 'r', false), 'x', false), 'y', true),
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['x', 'y'],
			rating: 'rated',
		})
	})

	it('is a draw when every Hunter failed it too', () => {
		const state = settled(
			answer(answer(answer(start(), 'r', false), 'x', false), 'y', false),
		)
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
	})

	it('R5: both Hunters forfeit without answering: the Runner wins', () => {
		const state = settled(
			send(
				send(answer(start(), 'r', false), 'x', { kind: 'forfeit' }).state,
				'y',
				{ kind: 'forfeit' },
			).state,
		)
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['r'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ r: 1, x: 2, y: 2 })
	})

	it('one Hunter failed it and the other forfeited: a draw', () => {
		const state = settled(
			send(answer(answer(start(), 'r', false), 'x', false), 'y', {
				kind: 'forfeit',
			}).state,
		)
		expect(state.result).toEqual({ kind: 'draw', rating: 'rated' })
	})
})

describe('settling', () => {
	it('changes nothing when no death waits (same object)', () => {
		const state = runState(['ann', 'bob'])
		expect(settled(state)).toBe(state)
	})

	it('changes nothing the second time', () => {
		const state = settled(
			answer(withLives(runState(['ann', 'bob']), { ann: 1 }), 'ann', false),
		)
		expect(settled(state)).toBe(state)
	})

	it('a decided match is left as it is', () => {
		const done: State = {
			...runState(['ann', 'bob']),
			result: { kind: 'agreed' },
		}
		expect(settled(done)).toBe(done)
	})
})

describe('exits', () => {
	it('a later change takes the next batch number', () => {
		const run = {
			...runOf(runState(['a', 'b', 'c'])),
			exits: [{ player: 'z', blindKey: null, batch: 4 }],
		}
		const after = {
			...run.lives,
			c: { ...run.lives.c, status: 'forfeited' as const },
		}
		expect(recordExits(run, after)).toEqual([
			run.exits[0],
			{ player: 'c', blindKey: null, batch: 5 },
		])
	})

	it('players who went out in one change share a place; a later exit ranks higher', () => {
		const base = withLives(runInMode(['a', 'b', 'c', 'd'], 'royale'), {
			a: 0,
			b: 0,
			c: 0,
		})
		const run = {
			...runOf(base),
			exits: [
				{ player: 'a', blindKey: KEY, batch: 1 },
				{ player: 'b', blindKey: null, batch: 1 },
				{ player: 'c', blindKey: '1:Big', batch: 2 },
			],
		}
		expect(settleDeaths(run, modeOf(run)).ending).toEqual({
			winners: ['d'],
			places: { a: 3, b: 3, c: 2, d: 1 },
		})
	})

	it('records who went out together in one batch', () => {
		const state = withLives(runState(['a', 'b', 'c']), { a: 1, b: 1 })
		const run = runOf(state)
		const after = {
			...run.lives,
			a: { ...run.lives.a, lives: 0, events: [{ delta: -1, cause: KEY }] },
			b: { ...run.lives.b, lives: 0, events: [{ delta: -1, cause: 'pvp:1' }] },
		}
		expect(recordExits(run, after)).toEqual([
			{ player: 'a', blindKey: KEY, batch: 1 },
			{ player: 'b', blindKey: null, batch: 1 },
		])
	})

	it('a forfeit is an exit with no blind', () => {
		const state = runState(['a', 'b', 'c'])
		const run = runOf(state)
		const after = {
			...run.lives,
			c: { ...run.lives.c, status: 'forfeited' as const },
		}
		expect(recordExits(run, after)).toEqual([
			{ player: 'c', blindKey: null, batch: 1 },
		])
	})
})

describe('Royale places', () => {
	const KEYS = ['1:Small', '1:Big', '1:Boss']

	it('c outlasted b, who outlasted a: no one shares a place across an exit in between', () => {
		const start = withLives(runInMode(['a', 'b', 'c', 'd'], 'royale'), {
			a: 1,
			b: 1,
			c: 1,
		})
		let state = settled(answer(start, 'a', false))
		state = settled(send(state, 'b', { kind: 'forfeit' }).state)
		state = settled(answer(state, 'c', false))
		state = settled(answer(state, 'd', true))
		expect(state.result).toEqual({
			kind: 'win',
			winners: ['d'],
			rating: 'rated',
		})
		expect(places(state)).toEqual({ d: 1, c: 2, b: 3, a: 4 })
	})

	it.each([
		[
			'two forfeits in a row',
			[
				{ player: 'a', blindKey: null, batch: 1 },
				{ player: 'b', blindKey: null, batch: 2 },
				{ player: 'c', blindKey: null, batch: 3 },
			],
			{ a: 4, b: 3, c: 2, d: 1 },
		],
		[
			'a forfeit, a leave, then a death on a blind',
			[
				{ player: 'a', blindKey: null, batch: 1 },
				{ player: 'b', blindKey: null, batch: 2 },
				{ player: 'c', blindKey: '1:Big', batch: 3 },
			],
			{ a: 4, b: 3, c: 2, d: 1 },
		],
		[
			'the same blind with nobody out between them share a place',
			[
				{ player: 'a', blindKey: KEY, batch: 1 },
				{ player: 'b', blindKey: KEY, batch: 2 },
				{ player: 'c', blindKey: null, batch: 3 },
			],
			{ a: 3, b: 3, c: 2, d: 1 },
		],
	])('%s', (_name, exits, expected) => {
		const base = withLives(runInMode(['a', 'b', 'c', 'd'], 'royale'), {
			a: 0,
			b: 0,
			c: 0,
		})
		const run = { ...runOf(base), exits }
		expect(settleDeaths(run, modeOf(run)).ending).toEqual({
			winners: ['d'],
			places: expected,
		})
	})

	const plan = fc.record({
		diesAt: fc.array(fc.integer({ min: 0, max: 3 }), {
			minLength: 3,
			maxLength: 5,
		}),
		picks: fc.array(fc.nat(), { minLength: 1, maxLength: 20 }),
	})

	it('a player who went out later never places below one who went out earlier, with exits interleaved across blinds', () => {
		fc.assert(
			fc.property(plan, ({ diesAt, picks }) => {
				const ids = diesAt.map((_, at) => `p${at}`)
				const lives: { [player: string]: number } = {}
				for (const id of ids) lives[id] = 1
				let state = withLives(runInMode(ids, 'royale'), lives)
				const answered = ids.map(() => 0)
				const wentOut: { [player: string]: number } = {}
				for (let step = 0; state.result === null; step++) {
					const next = ids.filter(
						(id, at) => answered[at] < KEYS.length && wentOut[id] === undefined,
					)
					if (next.length === 0) break
					const id = next[picks[step % picks.length] % next.length]
					const at = ids.indexOf(id)
					const dies = diesAt[at] === answered[at] + 1
					state = settled(answer(state, id, !dies, KEYS[answered[at]]))
					answered[at]++
					if (dies) wentOut[id] = step
				}
				if (state.result === null) return
				const placed = places(state)
				for (const later of Object.keys(wentOut))
					for (const earlier of Object.keys(wentOut))
						if (wentOut[later] > wentOut[earlier])
							expect(placed[later]).toBeLessThanOrEqual(placed[earlier])
				expect(Math.min(...Object.values(placed))).toBe(1)
				expect(settled(state)).toBe(state)
			}),
		)
	})
})

describe('opening a death directly', () => {
	const open = (
		state: State,
		mode = modeOf(runOf(state)),
		...causes: [string, string][]
	) => {
		return causes.reduce(
			(next, [player, cause]) => openWaitingDeath(next, mode, player, cause),
			runOf(state),
		).waitingDeaths
	}

	it('a player has one death at a time', () => {
		const state = runState(['ann', 'bob'])
		expect(open(state, undefined, ['ann', KEY], ['ann', '1:Big'])).toHaveLength(
			1,
		)
	})

	it('a side opens one death at a time', () => {
		const state = runInMode(['a', 'b', 'c', 'd'], 'teams', {
			a: 'A',
			b: 'A',
			c: 'B',
			d: 'B',
		})
		expect(open(state, undefined, ['a', KEY], ['b', KEY])).toHaveLength(1)
	})

	it('a PvP blind the player played opens none', () => {
		const state = runState(['ann', 'bob'])
		const run = runOf(state)
		const PLAYER = { stage: 'not entered' as const }
		const playing: State = {
			...state,
			run: {
				...run,
				rules: { ...run.rules, pvpStartAnte: 2 },
				currentPvpBlind: {
					blindKey: '2:Boss',
					players: { ann: PLAYER, bob: PLAYER },
					banks: {},
				},
			},
		}
		expect(open(playing, undefined, ['ann', '2:Boss'])).toEqual([])
		expect(open(playing, undefined, ['ann', '2:Big'])).toHaveLength(1)
	})
})

describe('a death answered by the PvP blind the other side played', () => {
	const teams = { a: 'A', b: 'A', c: 'B', d: 'B' } as const
	const afterPvpBlind = (losers: string[]) => {
		const run = runOf(runInMode(['a', 'b', 'c', 'd'], 'teams', teams))
		const currentPvpBlind: PvpBlindResult = {
			blindKey: '2:Boss',
			scores: { c: '1', d: '1' },
			endedBy: {},
			losers,
			livesAfter: { c: 4, d: 4 },
			teamScores: null,
		}
		return {
			...run,
			finishedPvpBlinds: [currentPvpBlind],
			waitingDeaths: [
				{ playerId: 'a', blindKey: '2:Boss', waitingFor: ['c', 'd'] },
			],
		}
	}

	it('a member who did not lose the PvP blind beat the blind: the other side wins', () => {
		const run = afterPvpBlind(['c'])
		expect(settleDeaths(run, modeOf(run)).ending?.winners).toEqual(['c', 'd'])
		const clean = afterPvpBlind([])
		expect(settleDeaths(clean, modeOf(clean)).ending?.winners).toEqual([
			'c',
			'd',
		])
	})

	it('every member lost the PvP blind: nobody beat the blind and it is a draw', () => {
		const run = afterPvpBlind(['c', 'd'])
		expect(settleDeaths(run, modeOf(run)).ending?.winners).toBeNull()
	})
})

describe('two deaths ending the game in one settle', () => {
	it('the first ending stands', () => {
		const base = runState(['ann', 'bob'])
		const run = runOf(base)
		const answers = (beaten: boolean) => ({
			results: {
				[KEY]: { result: beaten ? ('beaten' as const) : ('lost' as const) },
			},
		})
		const both: typeof run = {
			...run,
			players: {
				ann: { ...run.players.ann, ...answers(false) },
				bob: { ...run.players.bob, ...answers(true) },
			},
			lives: { ...run.lives, ann: { ...run.lives.ann, lives: 0 } },
			waitingDeaths: [
				{ playerId: 'ann', blindKey: KEY, waitingFor: ['bob'] },
				{ playerId: 'bob', blindKey: KEY, waitingFor: ['ann'] },
			],
		}
		expect(settleDeaths(both, modeOf(both)).ending?.winners).toEqual(['bob'])
	})
})

describe('settling without a death', () => {
	it('a royale with one player standing and no exit on record does not end', () => {
		const state = withLives(runInMode(['a', 'b', 'c'], 'royale'), {
			b: 0,
			c: 0,
		})
		const run = runOf(state)
		expect(settleDeaths(run, modeOf(run)).ending).toBeNull()
	})

	it('lives that did not change record no exit (the same list)', () => {
		const run = runOf(runState(['a', 'b']))
		expect(recordExits(run, run.lives)).toBe(run.exits)
	})

	it('a duel opponent that left, with lives still, lets the dead player win', () => {
		const dying = answer(
			withLives(runState(['ann', 'bob']), { ann: 1 }),
			'ann',
			false,
		)
		const run = runOf(dying)
		const left: State = {
			...dying,
			run: {
				...run,
				lives: { ...run.lives, bob: { ...run.lives.bob, status: 'left' } },
			},
		}
		expect(settled(left).result).toEqual({
			kind: 'win',
			winners: ['ann'],
			rating: 'rated',
		})
	})
})

describe('settleDeaths on state read back from Nakama', () => {
	it('returns the same run while a death still waits', () => {
		const state = settled(
			answer(withLives(runState(['ann', 'bob']), { ann: 1 }), 'ann', false),
		)
		const run = copyOnRead(runOf(state))
		expect(run.waitingDeaths).toHaveLength(1)
		expect(settleDeaths(run, modeOf(run)).run).toBe(run)
	})
})
