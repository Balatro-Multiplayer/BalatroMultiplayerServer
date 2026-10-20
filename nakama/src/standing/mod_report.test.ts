import { describe, expect, it } from 'vitest'
import { disallowedMods, parseReportedMod } from './mod_report'

describe('parseReportedMod', () => {
	it('splits where the version starts, though either half may hold hyphens', () => {
		expect(parseReportedMod('MultiplayerAPI-0.1.2')).toEqual({ key: 'MultiplayerAPI', version: '0.1.2' })
		expect(parseReportedMod('Steamodded-1.0.0~BETA-1814a')).toEqual({ key: 'Steamodded', version: '1.0.0~BETA-1814a' })
		expect(parseReportedMod('Some-Mod-UNK')).toEqual({ key: 'Some-Mod', version: 'UNK' })
		expect(parseReportedMod('Some-Mod-v2.1')).toEqual({ key: 'Some-Mod', version: 'v2.1' })
		expect(parseReportedMod('Mod-beta')).toEqual({ key: 'Mod', version: 'beta' })
		expect(parseReportedMod('NoVersion')).toEqual({ key: 'NoVersion', version: '' })
	})
})

describe('disallowedMods', () => {
	it('matches by id only, case-sensitive, each disallowed key once', () => {
		const allowed = ['Steamodded', 'Lovely', 'Some-Mod']
		expect(disallowedMods(['Steamodded-1.0.0~BETA-1814a', 'Lovely-0.9.0', 'Some-Mod-UNK'], allowed)).toEqual([])
		expect(disallowedMods(['steamodded-1.0', 'Talisman-2.0', 'Talisman-2.1', 'Lovely'], allowed)).toEqual([
			'steamodded',
			'Talisman',
		])
		// An allowed id is not a prefix of a longer one.
		expect(disallowedMods(['SteamoddedPlus-1.0'], allowed)).toEqual(['SteamoddedPlus'])
	})
})
