// Copy of apps/server/src/shared/constants/jokers.ts (the Nakama module is
// bundled on its own and can't import from the API). The API's
// nakama-jokers-parity test fails when the two lists drift apart.
export const STANDARD_JOKERS: string[] = [
	'j_joker',
	'j_mime',
	'j_chaos',
	'j_space',
	'j_scholar',
	'j_egg',
	'j_burglar',
	'j_runner',
	'j_sixth_sense',
	'j_hiker',
	'j_card_sharp',
	'j_madness',
	'j_vampire',
	'j_baron',
	'j_fortune_teller',
	'j_luchador',
	'j_lucky_cat',
	'j_bull',
	'j_swashbuckler',
	'j_throwback',
	'j_mr_bones',
	'j_ring_master',
	'j_idol',
	'j_merry_andy',
	'j_stuntman',
	'j_matador',
	'j_troubadour',
	'j_ancient',
	'j_even_steven',
	'j_odd_todd',
]

// privilege -> the joker it unlocks.
export const PRIVILEGE_JOKERS: { [privilege: string]: string } = {
	virtualized: 'j_perkeo',
	bean: 'j_turtle_bean',
	vagabond: 'j_vagabond',
	sizaak: 'j_dusk',
	lava: 'j_burnt',
	twelve: 'j_stone',
}

export const DEFAULT_JOKER = 'j_joker'

export function isValidJoker(id: string, privileges: string[] = []): boolean {
	if (STANDARD_JOKERS.indexOf(id) !== -1) return true
	return privileges.some((p) => PRIVILEGE_JOKERS[p] === id)
}

// The client's privilege table (the API's buildPrivilegeTable).
export function privilegeTable(privileges: string[]): { jokers?: string[] } {
	const jokers = privileges.map((p) => PRIVILEGE_JOKERS[p]).filter((j): j is string => !!j)
	return jokers.length > 0 ? { jokers } : {}
}
