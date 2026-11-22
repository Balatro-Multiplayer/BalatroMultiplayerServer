import { describe, expect, it } from 'vitest'

import type { PvpMode } from '../rules/settings'
import { runFor, withLives } from '../testing/view'
import { duelLosers, duelMode } from './duel'
import { modeOf, pickMode } from './index'
import { manhuntMode } from './manhunt'
import { nemesisMode } from './nemesis'
import { royaleMode } from './royale'
import { teamsMode } from './teams'

const ids = (count: number): string[] =>
	Array.from({ length: count }, (_v, i) => String.fromCharCode(97 + i))

describe('pickMode', () => {
	it.each<[PvpMode, number, number | undefined, string, boolean]>([
		['manhunt', 2, undefined, 'manhunt', false],
		['manhunt', 4, 2, 'manhunt', false],
		['teams', 2, undefined, 'teams', false],
		['teams', 6, 2, 'teams', false],
		['nemesis', 2, undefined, 'duel', false],
		['royale', 2, undefined, 'duel', false],
		['nemesis', 3, undefined, 'nemesis', false],
		['royale', 3, undefined, 'royale', false],
		['nemesis', 4, 4, 'nemesis', false],
		['royale', 5, 3, 'royale', false],
		['nemesis', 4, 2, 'nemesis', true],
		['royale', 4, 2, 'royale', true],
	])(
		'%s of %i started, %s still in the lobby: %s (final two %s)',
		(mode, started, playersStillInLobby, name, final) => {
			const picked = pickMode(mode, started, playersStillInLobby)
			expect(picked.name).toBe(name)
			expect(picked.losersOf === duelLosers).toBe(name === 'duel' || final)
		},
	)

	it('returns the shared mode objects', () => {
		expect(pickMode('manhunt', 3)).toBe(manhuntMode)
		expect(pickMode('teams', 4)).toBe(teamsMode)
		expect(pickMode('nemesis', 2)).toBe(duelMode)
		expect(pickMode('nemesis', 5)).toBe(nemesisMode)
		expect(pickMode('royale', 5)).toBe(royaleMode)
	})

	it('a final two keeps its mode rules but plays the duel PvP blind and targets', () => {
		for (const [mode, base] of [
			['royale', royaleMode],
			['nemesis', nemesisMode],
		] as const) {
			const two = pickMode(mode, 4, 2)
			expect(two.deathWaitsOn).toBe(base.deathWaitsOn)
			expect(two.checkWinner).toBe(base.checkWinner)
			expect(two.losersOf).toBe(duelLosers)
			expect(two.view).not.toBe(base.view)
		}
	})

	it('the final-two targets are the alive duelists', () => {
		const dueling = withLives(runFor('royale', ids(3)), { c: { lives: 0 } })
		expect(pickMode('royale', 3, 2).view(dueling, null)).toEqual({
			opponents: { a: 'b', b: 'a' },
		})
	})
})

describe('modeOf', () => {
	it('follows the frozen mode and the players still in the lobby', () => {
		expect(modeOf(runFor('royale', ids(4)))).toBe(royaleMode)
		expect(modeOf(runFor('nemesis', ids(4)))).toBe(nemesisMode)
		expect(modeOf(runFor('manhunt', ids(3)))).toBe(manhuntMode)
		expect(modeOf(runFor('teams', ids(4)))).toBe(teamsMode)
		expect(modeOf(runFor('nemesis', ids(2)))).toBe(duelMode)
	})

	it('turns to the final two when players leave', () => {
		const two = withLives(runFor('royale', ids(4)), {
			c: { status: 'left' },
			d: { status: 'left' },
		})
		expect(modeOf(two).losersOf).toBe(duelLosers)
	})
})

// Each mode's choices for the shared code. These replaced checks on the mode's name,
// so a changed value here changes a rule.
describe('mode policies', () => {
	it.each([
		['duel', duelMode, 'opponent', false, false, false, 'none'],
		['royale', royaleMode, 'everyone', false, false, false, 'none'],
		['nemesis', nemesisMode, 'everyone', false, false, false, 'by ante'],
		['manhunt', manhuntMode, 'side', false, true, true, 'none'],
		['teams', teamsMode, 'side', true, false, false, 'none'],
	] as const)(
		'%s',
		(
			_name,
			mode,
			deathWaitsOn,
			hasLifePool,
			hasSideDeath,
			hasVoucherRule,
			pairs,
		) => {
			expect(mode.deathWaitsOn).toBe(deathWaitsOn)
			expect(mode.lifePool !== undefined).toBe(hasLifePool)
			expect(mode.opensSideDeath !== undefined).toBe(hasSideDeath)
			expect(mode.mayRedeemVoucher !== undefined).toBe(hasVoucherRule)
			expect(mode.pairs).toBe(pairs)
		},
	)
})
