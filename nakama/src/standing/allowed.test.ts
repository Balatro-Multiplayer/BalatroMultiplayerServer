import { describe, expect, it } from 'vitest'
import { allowedModIds, standingInputsChanged } from './allowed'

const config = (ids: string[], extra: string[] = [], enforced = false) => ({
	queueAllowedModIds: ids,
	queueAllowedModIdsExtra: extra,
	queueModsEnforced: enforced,
})

describe('allowedModIds', () => {
	it('is the baseline, the pinned ids and the extra ids, each once', () => {
		expect(allowedModIds(config(['MultiplayerAPI', 'Steamodded'], ['ClaudeControl']))).toEqual([
			'Balatro',
			'Steamodded',
			'Lovely',
			'MultiplayerAPI',
			'ClaudeControl',
		])
	})
})

describe('standingInputsChanged', () => {
	it('notices enforcement and allowlist changes, not reorderings', () => {
		expect(standingInputsChanged(config(['A', 'B']), config(['B', 'A']))).toBe(false)
		expect(standingInputsChanged(config(['A']), config(['A'], ['X']))).toBe(true)
		expect(standingInputsChanged(config(['A']), config([]))).toBe(true)
		expect(standingInputsChanged(config(['A']), config(['A'], [], true))).toBe(true)
		// A baseline id pinned too changes nothing.
		expect(standingInputsChanged(config([]), config(['Steamodded']))).toBe(false)
	})
})
