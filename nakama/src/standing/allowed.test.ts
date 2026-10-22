import { describe, expect, it } from 'vitest'
import { allowedModIds, parseExtraSeed, seededExtra, standingInputsChanged } from './allowed'

const config = (ids: string[], extra: string[] = []) => ({
	queueAllowedModIds: ids,
	queueAllowedModIdsExtra: extra,
})

describe('allowedModIds', () => {
	it('is the baseline, the pinned ids and the extra ids, each once', () => {
		expect(allowedModIds(config(['MultiplayerAPI', 'Steamodded', 'Talisman'], ['ClaudeControl']))).toEqual([
			'Balatro',
			'Steamodded',
			'Lovely',
			'lovely-compat-BMM-Compat',
			'MultiplayerAPI',
			'MultiplayerSPDRN',
			'MultiplayerPvP',
			'Talisman',
			'ClaudeControl',
		])
	})
	it('always allows the BMP mods, even with nothing pinned', () => {
		const ids = allowedModIds(config([]))
		for (const id of ['MultiplayerAPI', 'MultiplayerSPDRN', 'MultiplayerPvP']) expect(ids).toContain(id)
	})
})

describe('standingInputsChanged', () => {
	it('notices allowlist changes, not reorderings', () => {
		expect(standingInputsChanged(config(['A', 'B']), config(['B', 'A']))).toBe(false)
		expect(standingInputsChanged(config(['A']), config(['A'], ['X']))).toBe(true)
		expect(standingInputsChanged(config(['A']), config([]))).toBe(true)
		// A baseline id pinned too changes nothing.
		expect(standingInputsChanged(config([]), config(['Steamodded']))).toBe(false)
	})
})

describe('the extra-id seed (QUEUE_ALLOWED_MOD_IDS_EXTRA)', () => {
	it('reads comma or space separated ids, and nothing from an unset, empty or bad value', () => {
		expect(parseExtraSeed('MultiplayerPvP,ClaudeControl')).toEqual(['MultiplayerPvP', 'ClaudeControl'])
		expect(parseExtraSeed(' MultiplayerPvP , ClaudeControl  Talisman ')).toEqual([
			'MultiplayerPvP',
			'ClaudeControl',
			'Talisman',
		])
		expect(parseExtraSeed(undefined)).toBeNull()
		expect(parseExtraSeed('')).toBeNull()
		expect(parseExtraSeed(' , ')).toBeNull()
		expect(parseExtraSeed('ok,' + 'x'.repeat(129))).toBeNull()
	})
	it('only adds: keeps what is there, adds each missing seeded id once', () => {
		expect(seededExtra([], ['MultiplayerPvP', 'ClaudeControl'])).toEqual(['MultiplayerPvP', 'ClaudeControl'])
		expect(seededExtra(['Talisman', 'ClaudeControl'], ['MultiplayerPvP', 'ClaudeControl', 'MultiplayerPvP'])).toEqual([
			'Talisman',
			'ClaudeControl',
			'MultiplayerPvP',
		])
		expect(seededExtra(['ClaudeControl', 'MultiplayerPvP'], ['MultiplayerPvP'])).toBeNull()
	})
})
