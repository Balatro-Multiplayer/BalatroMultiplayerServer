// The Nakama module keeps its own copy of the joker list (it can't import
// from the API); this keeps the two in step.
import { describe, expect, it } from 'vitest'
import { PRIVILEGE_JOKERS, STANDARD_JOKERS } from '../../shared/constants/jokers.js'
import { buildPrivilegeTable } from '../../shared/constants/privileges.js'
import * as nakama from '../../../../../nakama/src/shared/jokers'

describe('Nakama joker list parity', () => {
	it('has the same standard jokers', () => {
		expect([...nakama.STANDARD_JOKERS].sort()).toEqual([...STANDARD_JOKERS].sort())
	})

	it('has the same privilege jokers', () => {
		expect(nakama.PRIVILEGE_JOKERS).toEqual(Object.fromEntries(PRIVILEGE_JOKERS))
	})

	it('builds the same privilege table', () => {
		for (const privileges of [[], ...[...PRIVILEGE_JOKERS.keys()].map((p) => [p]), [...PRIVILEGE_JOKERS.keys()]]) {
			expect(nakama.privilegeTable(privileges)).toEqual(buildPrivilegeTable(privileges as never))
		}
	})
})
