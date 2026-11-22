import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { settingsAtStart, withRules } from '../testing/rules'
import {
	type AnteClock,
	type ClockRules,
	type PvpMode,
	clockSettingOf,
	isBlindKey,
	isBossBlind,
	modeOfQueue,
	settingsFromLobby,
} from './settings'

const PVP_CLOCK = { baseMilliseconds: 60_000, handMilliseconds: 10_000 }

// Every ruleset the PvP mod registers. A byte-identical copy lives in the PvP repo
// (tests/fixtures/net-v1/ruleset_ids.json), where a test checks it against the mod's
// rulesets/ files; this side checks it against the clock table.
const RULESET_IDS: string[] = JSON.parse(
	readFileSync(new URL('../testing/ruleset_ids.json', import.meta.url), 'utf8'),
)

const two = ['a', 'b']
const three = ['a', 'b', 'c']

describe('modeOfQueue', () => {
	it.each<[unknown, PvpMode | null]>([
		['pvp_nemesis', 'nemesis'],
		['pvp_experimental', 'nemesis'],
		['pvp_manhunt', 'manhunt'],
		['pvp_teams', 'teams'],
		['pvp_royale', 'royale'],
		['pvp_smallworld', 'royale'],
		['pvp_unknown', null],
		['toString', null],
		['', null],
		[undefined, null],
		[7, null],
	])('%s is %s', (queueMode, mode) => {
		expect(modeOfQueue(queueMode)).toBe(mode)
	})
})

describe('settingsAtStart', () => {
	it('reads every key of a complete lobby', () => {
		expect(settingsAtStart(withRules(), two)).toEqual({
			mode: 'nemesis',
			startedCount: 2,
			startingLives: 4,
			hunterLives: 7,
			pvpStartAnte: 2,
			clocks: { ante: 'none', pvp: null, personal: null },
			timerBaseMilliseconds: 150_000,
			timerIncrementMilliseconds: null,
			skipTimeRule: 'lead',
			timerDisplayThresholdMilliseconds: null,
			timerForgiveness: 0,
			failedBlindLife: 'costs',
			lifeLossGold: 'paid',
		})
	})

	it('reads the host-written keys', () => {
		expect(
			settingsAtStart(
				withRules({
					queue_mode: 'pvp_manhunt',
					starting_lives: 6,
					manhunt_hunter_lives: '9',
					pvp_start_ante: 3,
					ruleset: 'ruleset_mp_experimental',
				}),
				three,
			),
		).toEqual({
			mode: 'manhunt',
			startedCount: 3,
			startingLives: 6,
			hunterLives: 9,
			pvpStartAnte: 3,
			clocks: {
				ante: 'personal',
				pvp: { baseMilliseconds: 60_000, handMilliseconds: 10_000 },
				personal: {
					kind: 'pressure',
					baseMilliseconds: 300_000,
					timedRate: 2,
					previewCostMilliseconds: 3500,
				},
			},
			timerBaseMilliseconds: 150_000,
			timerIncrementMilliseconds: null,
			skipTimeRule: 'lead',
			timerDisplayThresholdMilliseconds: null,
			timerForgiveness: 0,
			failedBlindLife: 'costs',
			lifeLossGold: 'paid',
		})
	})

	it.each<[string, unknown, number]>([
		['90 seconds', 90, 90_000],
		['a numeric string', '45', 45_000],
		['a fraction PvP blinds to whole ms', 10.0004, 10_000],
		['the 10 s floor', 10, 10_000],
		['the 60 min ceiling', 3600, 3_600_000],
	])('timer_base_seconds %s', (_name, value, expected) => {
		expect(
			settingsAtStart(withRules({ timer_base_seconds: value }), two)
				.timerBaseMilliseconds,
		).toBe(expected)
	})

	// main core.lua:211,213: both options default on; a lobby that omits them (matchmade,
	// practice) plays the default.
	it.each<
		[string, { [key: string]: unknown }, 'costs' | 'free', 'paid' | 'none']
	>([
		['both absent', {}, 'costs', 'paid'],
		[
			'both on',
			{ death_on_normal_blind_loss: true, gold_on_life_loss: true },
			'costs',
			'paid',
		],
		['deaths off', { death_on_normal_blind_loss: false }, 'free', 'paid'],
		['gold off', { gold_on_life_loss: false }, 'costs', 'none'],
		[
			'both off',
			{ death_on_normal_blind_loss: false, gold_on_life_loss: false },
			'free',
			'none',
		],
	])('lobby options: %s', (_name, options, failedBlindLife, lifeLossGold) => {
		const settings = settingsAtStart(withRules(options), two)
		expect(settings.failedBlindLife).toBe(failedBlindLife)
		expect(settings.lifeLossGold).toBe(lifeLossGold)
	})

	it.each(['death_on_normal_blind_loss', 'gold_on_life_loss'])(
		'%s present but not a boolean is bad_rules naming it',
		(key) => {
			for (const value of ['true', 0, 1, null, {}])
				expect(settingsFromLobby(withRules({ [key]: value }), two)).toEqual({
					ok: false,
					reason: 'bad_rules',
					key,
				})
		},
	)

	it.each<[string, unknown, number]>([
		['3 forgiven', 3, 3],
		['a numeric string', '2', 2],
		['the ceiling', 9, 9],
		['none', 0, 0],
	])('timer_forgiveness %s', (_name, value, expected) => {
		expect(
			settingsAtStart(withRules({ timer_forgiveness: value }), two)
				.timerForgiveness,
		).toBe(expected)
	})

	it.each<[string, ClockRules['pvp']]>([
		['ruleset_mp_experimental', PVP_CLOCK],
		['ruleset_mp_balanced', PVP_CLOCK],
		['ruleset_mp_expanded', PVP_CLOCK],
		['ruleset_mp_almanac', PVP_CLOCK],
		['ruleset_mp_speedlatro', null],
		['ruleset_mp_majorleague', null],
	])('clocks.pvp of %s', (ruleset, pvp) => {
		expect(settingsAtStart(withRules({ ruleset }), two).clocks.pvp).toEqual(pvp)
	})

	it.each<[string, { [k: string]: unknown }, 'bad_rules' | AnteClock]>([
		['a missing ruleset', {}, 'bad_rules'],
		['an unknown ruleset', { ruleset: 'ruleset_mp_nope' }, 'bad_rules'],
		['an inherited key', { ruleset: 'toString' }, 'bad_rules'],
		['a non-string ruleset', { ruleset: 7 }, 'bad_rules'],
		[
			'experimental_legacy',
			{ ruleset: 'ruleset_mp_experimental_legacy' },
			'bank',
		],
		['balanced', { ruleset: 'ruleset_mp_balanced' }, 'bank'],
		['majorleague', { ruleset: 'ruleset_mp_majorleague' }, 'bank'],
		['experimental', { ruleset: 'ruleset_mp_experimental' }, 'personal'],
		['speedlatro', { ruleset: 'ruleset_mp_speedlatro' }, 'personal'],
		['chaos', { ruleset: 'ruleset_mp_chaos' }, 'personal'],
		['traditional', { ruleset: 'ruleset_mp_traditional' }, 'none'],
	])('the ante clock of %s', (_name, overrides, expected) => {
		const found = clockSettingOf(overrides.ruleset)
		expect(found.ok ? found.clock.ante : found.reason).toBe(expected)
		const lobbySettings = withRules({ ruleset: overrides.ruleset })
		if (expected === 'bad_rules')
			expect(settingsFromLobby(lobbySettings, two)).toEqual({
				ok: false,
				reason: 'bad_rules',
				key: 'ruleset',
			})
		else expect(settingsAtStart(lobbySettings, two).clocks.ante).toBe(expected)
	})

	it.each(RULESET_IDS)('%s is in the table', (ruleset) => {
		expect(clockSettingOf(ruleset).ok).toBe(true)
	})

	it('Speedlatro and Chaos keep their numbers; Pressure reads the lobby base', () => {
		const speedlatro = {
			kind: 'speedlatro',
			baseMilliseconds: 147_000,
			pvpMilliseconds: 73_500,
			timedRate: 2,
			previewCostMilliseconds: 0,
		}
		for (const ruleset of ['ruleset_mp_speedlatro', 'ruleset_mp_chaos'])
			expect(
				settingsAtStart(withRules({ ruleset }), two).clocks.personal,
			).toEqual(speedlatro)
		expect(
			settingsAtStart(
				withRules({
					ruleset: 'ruleset_mp_experimental',
					timer_base_seconds: 100,
				}),
				two,
			).clocks.personal,
		).toEqual({
			kind: 'pressure',
			baseMilliseconds: 200_000,
			timedRate: 2,
			previewCostMilliseconds: 3500,
		})
	})

	it('starting_lives takes 1 to 10', () => {
		expect(
			settingsAtStart(withRules({ starting_lives: 10 }), two).startingLives,
		).toBe(10)
		expect(
			settingsAtStart(withRules({ starting_lives: 1 }), two).startingLives,
		).toBe(1)
	})

	it('starting_lives reads a whole number or a numeric string', () => {
		expect(
			settingsAtStart(withRules({ starting_lives: '5' }), two).startingLives,
		).toBe(5)
	})

	it('a lobby that writes timer_increment_seconds as null has no skip time', () => {
		expect(
			settingsAtStart(withRules({ timer_increment_seconds: null }), two)
				.timerIncrementMilliseconds,
		).toBeNull()
	})
})

// The server reads what the client always writes and invents nothing. A key it
// reads that is missing or malformed is a bad_rules result naming the key.
describe('settingsFromLobby refuses a missing or malformed key', () => {
	const missingOrBad: [string, string, unknown][] = [
		['ruleset', 'a missing ruleset', undefined],
		['queue_mode', 'a missing queue_mode', undefined],
		['queue_mode', 'an unknown queue_mode', 'pvp_mystery'],
		['queue_mode', 'an inherited queue_mode', 'toString'],
		['starting_lives', 'a missing starting_lives', undefined],
		['starting_lives', 'zero lives', 0],
		['starting_lives', 'negative lives', -3],
		['starting_lives', 'fractional lives', 2.5],
		['starting_lives', 'text lives', 'abc'],
		['starting_lives', 'null lives', null],
		['manhunt_hunter_lives', 'a missing hunter lives', undefined],
		['manhunt_hunter_lives', 'zero hunter lives', '0'],
		['pvp_start_ante', 'a missing pvp_start_ante', undefined],
		['pvp_start_ante', 'an empty pvp_start_ante', ''],
		['timer_base_seconds', 'a missing timer base', undefined],
		['timer_base_seconds', 'a text timer base', 'abc'],
		['timer_base_seconds', 'a null timer base', null],
		['timer_base_seconds', 'an infinite timer base', Number.POSITIVE_INFINITY],
		['timer_base_seconds', 'a timer base under 10 s', 3],
		['timer_base_seconds', 'a zero timer base', 0],
		['timer_base_seconds', 'a negative timer base', -5],
		['timer_base_seconds', 'a timer base over 60 min', 7200],
		['timer_forgiveness', 'a forgiveness over 9', 12],
		['timer_forgiveness', 'a negative forgiveness', -1],
		['timer_forgiveness', 'a fractional forgiveness', 0.5],
		['starting_lives', 'more than 10 lives', 11],
		['timer_forgiveness', 'a missing forgiveness', undefined],
		['timer_forgiveness', 'a text forgiveness', 'x'],
		['timer_increment_seconds', 'a missing increment', undefined],
		['timer_increment_seconds', 'a text increment', 'soon'],
	]

	it.each(missingOrBad)('%s: %s', (key, _name, value) => {
		expect(settingsFromLobby(withRules({ [key]: value }), two)).toEqual({
			ok: false,
			reason: 'bad_rules',
			key,
		})
	})

	it('names the first bad key when several are bad', () => {
		const result = settingsFromLobby(
			withRules({ starting_lives: 'x', timer_base_seconds: 'y' }),
			two,
		)
		expect(result).toEqual({
			ok: false,
			reason: 'bad_rules',
			key: 'starting_lives',
		})
	})

	it.each(['ruleset_mp_majorleague', 'ruleset_mp_minorleague'])(
		'%s needs no timer keys: it forces them',
		(ruleset) => {
			const result = settingsFromLobby(
				withRules({
					ruleset,
					timer_base_seconds: undefined,
					timer_forgiveness: undefined,
				}),
				two,
			)
			expect(result.ok).toBe(true)
		},
	)

	it('never throws on hostile metadata', () => {
		expect(() =>
			settingsFromLobby(
				{ ruleset: {}, queue_mode: [], starting_lives: {} },
				two,
			),
		).not.toThrow()
	})
})

describe('queue_mode x startedCount -> mode', () => {
	it.each([
		['pvp_nemesis', two, 'nemesis'],
		['pvp_nemesis', three, 'nemesis'],
		['pvp_experimental', two, 'nemesis'],
		['pvp_experimental', three, 'nemesis'],
		['pvp_royale', two, 'royale'],
		['pvp_royale', three, 'royale'],
		['pvp_smallworld', two, 'royale'],
		['pvp_smallworld', three, 'royale'],
		['pvp_manhunt', two, 'manhunt'],
		['pvp_manhunt', three, 'manhunt'],
		['pvp_teams', two, 'teams'],
		['pvp_teams', three, 'teams'],
	])('%s with %i players', (queueMode, ids, mode) => {
		const settings = settingsAtStart(withRules({ queue_mode: queueMode }), ids)
		expect(settings.mode).toBe(mode)
		expect(settings.startedCount).toBe(ids.length)
	})
})

describe('isBlindKey and isBossBlind', () => {
	it.each<[unknown, boolean]>([
		['2:Boss', true],
		['10:Small', true],
		['1:Big', true],
		['Boss', false],
		['2:boss', false],
		['02:Small', false],
		['002:Boss', false],
		['0:Boss', true],
		['-1:Small', false],
		['1.5:Big', false],
		['2:Boss\n', false],
		[2, false],
		[undefined, false],
	])('isBlindKey(%j) is %s', (value, ok) => {
		expect(isBlindKey(value)).toBe(ok)
	})

	it.each([
		['2:Boss', true],
		['1:Boss', true],
		['0:Boss', true],
		['2:Small', false],
		['9:Big', false],
	])('isBossBlind(%s) is %s', (blindKey, expected) => {
		expect(isBossBlind(blindKey)).toBe(expected)
	})
})

// The league rulesets force the lobby's timers (the client's majorleague.lua:11-12 and
// minorleague.lua:7-8): whatever the host's lobby metadata says, the frozen settings
// read the forced numbers.
describe('the league rulesets force their timers', () => {
	const host = { timer_base_seconds: 600, timer_forgiveness: 3 }
	it.each([
		['ruleset_mp_majorleague', 180_000, 0],
		['ruleset_mp_minorleague', 210_000, 1],
	])(
		'%s freezes base %i ms and forgiveness %i whatever the host wrote',
		(ruleset, baseMilliseconds, forgiveness) => {
			const runRules = settingsAtStart(withRules({ ruleset, ...host }), two)
			expect(runRules.timerBaseMilliseconds).toBe(baseMilliseconds)
			expect(runRules.timerForgiveness).toBe(forgiveness)
		},
	)

	it('a ruleset without forced timers still reads the host values', () => {
		const runRules = settingsAtStart(withRules(host), two)
		expect(runRules.timerBaseMilliseconds).toBe(600_000)
		expect(runRules.timerForgiveness).toBe(3)
	})
})

// A lobby write of a rule key out of range is refused and the lobby keeps its value.

// The lobby's Timer toggle (the PvP mod's `timer`): absent is on, off removes every clock.
describe('settingsFromLobby timer option', () => {
	const clocksOf = (timer: unknown, ruleset = 'ruleset_mp_balanced') =>
		settingsAtStart(withRules({ ruleset, timer }), two).clocks

	it.each([
		['ruleset_mp_balanced'],
		['ruleset_mp_expanded'],
		['ruleset_mp_experimental'],
		['ruleset_mp_majorleague'],
	])('%s: on and absent keep the ruleset clocks, off has none', (ruleset) => {
		const on = clocksOf(true, ruleset)
		expect(clocksOf(undefined, ruleset)).toEqual(on)
		expect(on).not.toEqual({ ante: 'none', pvp: null, personal: null })
		expect(clocksOf(false, ruleset)).toEqual({
			ante: 'none',
			pvp: null,
			personal: null,
		})
	})

	it.each([['ruleset_mp_speedlatro'], ['ruleset_mp_chaos']])(
		'%s: off keeps the Speedlatro clock, as on main',
		(ruleset) => {
			const on = clocksOf(true, ruleset)
			expect(on.personal?.kind).toBe('speedlatro')
			expect(clocksOf(false, ruleset)).toEqual(on)
		},
	)

	it.each([['yes'], [1], [null]])('%s is refused by key', (value) => {
		expect(settingsFromLobby(withRules({ timer: value }), two)).toEqual({
			ok: false,
			reason: 'bad_rules',
			key: 'timer',
		})
	})
})
