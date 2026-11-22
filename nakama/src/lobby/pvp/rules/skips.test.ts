import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { settingsAtStart, withRules } from '../testing/rules'
import { skipsReported } from './skips'

describe('settings: increment and rule from the lobby metadata', () => {
	it.each<[string, { [k: string]: unknown }, number | null, 'lead' | 'own']>([
		['no increment (null): never an invented one', {}, null, 'lead'],
		['60 seconds', { timer_increment_seconds: 60 }, 60_000, 'lead'],
		['a numeric string', { timer_increment_seconds: '45' }, 45_000, 'lead'],
		['a negative one pays nothing', { timer_increment_seconds: -5 }, 0, 'lead'],
		[
			'Major League counts every own skip',
			{ ruleset: 'ruleset_mp_majorleague', timer_increment_seconds: 60 },
			60_000,
			'own',
		],
		[
			'another ruleset keeps the lead rule',
			{ ruleset: 'ruleset_mp_balanced' },
			null,
			'lead',
		],
	])('%s', (_name, lobbySettings, incrementMilliseconds, rule) => {
		const runRules = settingsAtStart(withRules(lobbySettings), ['a', 'b'])
		expect(runRules.timerIncrementMilliseconds).toBe(incrementMilliseconds)
		expect(runRules.skipTimeRule).toBe(rule)
	})
})

describe('skipsReported', () => {
	it('a resend is the same entries back', () => {
		const once = skipsReported({}, 'a', 2)
		expect(skipsReported(once, 'a', 2)).toBe(once)
	})
})
