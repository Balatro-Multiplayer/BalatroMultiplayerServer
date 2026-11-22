import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lockedRulesFor, lockedRulesForRankedMode } from './locked_rules'
import { settingsFromLobby } from './settings'

// The five ranked tickets the client queues (pvp_api/queue.lua, PVP._join_ranked_ruleset:
// balanced, expanded, vanilla, majorleague, smallworld), each "pvp_ranked_<ruleset short>".
// The client's lobby defaults (core.lua) give lives 4, PvP from ante 2, a 150 s base,
// no forgiveness and a 60 s skip increment; the league ruleset forces its own timers.
const OPEN = {
	queue_mode: 'pvp_nemesis',
	starting_lives: 4,
	manhunt_hunter_lives: 7,
	pvp_start_ante: 2,
	timer_base_seconds: 150,
	timer_forgiveness: 0,
	timer_increment_seconds: 60,
}

describe('lockedRulesForRankedMode: the rules a ranked lobby is pinned to', () => {
	it.each([
		['balanced', { ruleset: 'ruleset_mp_balanced', ...OPEN }],
		['expanded', { ruleset: 'ruleset_mp_expanded', ...OPEN }],
		['vanilla', { ruleset: 'ruleset_mp_vanilla', ...OPEN }],
		['smallworld', { ruleset: 'ruleset_mp_smallworld', ...OPEN }],
	])(
		'pvp_ranked_%s pins its ruleset, Nemesis, lives, start ante and timers',
		(short, locked) => {
			expect(lockedRulesForRankedMode(`pvp_ranked_${short}`)).toEqual({
				ok: true,
				locked,
			})
		},
	)

	it('pvp_ranked_majorleague leaves the timers the ruleset forces out of the pin', () => {
		expect(lockedRulesForRankedMode('pvp_ranked_majorleague')).toEqual({
			ok: true,
			locked: {
				ruleset: 'ruleset_mp_majorleague',
				queue_mode: 'pvp_nemesis',
				starting_lives: 4,
				manhunt_hunter_lives: 7,
				pvp_start_ante: 2,
				timer_increment_seconds: 60,
			},
		})
	})

	it.each([
		'',
		'pvp_ranked_standard',
		'pvp_ranked_',
		'pvp_ranked_chaos',
		'ranked:pvp_ranked_balanced',
		'balanced',
		'pvp_ranked_toString',
		'pvp_ranked___proto__',
	])('%j is an unknown ranked mode', (mode) => {
		expect(lockedRulesForRankedMode(mode)).toEqual({
			ok: false,
			reason: 'unknown_ranked_mode',
		})
	})

	it.each(['balanced', 'expanded', 'vanilla', 'majorleague', 'smallworld'])(
		'a pin plus the keys the host adds always freezes (pvp_ranked_%s)',
		(short) => {
			const found = lockedRulesForRankedMode(`pvp_ranked_${short}`)
			if (!found.ok) throw new Error('no pin')
			const lobbySettings = {
				...found.locked,
				manhunt_hunter_lives: 7,
				deck: 'Red Deck',
			}
			expect(settingsFromLobby(lobbySettings, ['a', 'b']).ok).toBe(true)
		},
	)
})

const PVP = 'MultiplayerPvP'

describe('lockedRulesFor: which lobbies are pinned', () => {
	it('a PvP ranked lobby takes its pin', () => {
		expect(lockedRulesFor(PVP, 'pvp_ranked_balanced', PVP)).toEqual(
			lockedRulesForRankedMode('pvp_ranked_balanced'),
		)
	})

	it('a casual lobby (no ranked mode) and another mod have no pin', () => {
		expect(lockedRulesFor(PVP, '', PVP)).toEqual({
			ok: true,
			locked: {},
		})
		expect(lockedRulesFor('MultiplayerSPDRN', 'duel', PVP)).toEqual({
			ok: true,
			locked: {},
		})
	})

	it('an unknown PvP ranked mode is refused', () => {
		expect(lockedRulesFor(PVP, 'pvp_ranked_standard', PVP)).toEqual({
			ok: false,
			reason: 'unknown_ranked_mode',
		})
	})
})
