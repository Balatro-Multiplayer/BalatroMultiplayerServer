// Every avatar a player can show, by the vanilla joker key the client draws.
// AVATAR_IDS is the closed list; catalog.ts gives each one its unlock rule.
export const AVATAR_IDS = [
	// Defaults
	'j_joker',
	'j_jolly',
	'j_zany',
	'j_mad',
	'j_crazy',
	'j_droll',
	'j_sly',
	'j_wily',
	'j_clever',
	'j_devious',
	'j_crafty',
	// Wins
	'j_baron',
	'j_lucky_cat',
	'j_smiley',
	'j_midas_mask',
	// Games played
	'j_swashbuckler',
	'j_vampire',
	'j_photograph',
	'j_square',
	'j_scary_face',
	'j_madness',
	// Days played
	'j_odd_todd',
	'j_even_steven',
	'j_ancient',
	// Win streak
	'j_fortune_teller',
	'j_sixth_sense',
	// PvP games
	'j_faceless',
	'j_bull',
	'j_card_sharp',
	// Speedrun games
	'j_space',
	'j_astronomer',
	'j_constellation',
	// Speedrun milestones
	'j_runner',
	'j_hiker',
	// Unique achievements
	'j_idol',
	'j_luchador',
	'j_matador',
	'j_scholar',
	'j_stuntman',
	'j_wee',
	'j_burglar',
	'j_chaos',
	'j_egg',
	'j_mr_bones',
	'j_ring_master',
	'j_pareidolia',
	'j_throwback',
	'j_blue_joker',
	'j_green_joker',
	'j_golden',
	'j_smeared',
	// Reserved for modes that don't exist yet
	'j_troubadour',
	'j_blueprint',
	'j_merry_andy',
	'j_brainstorm',
	'j_abstract',
	// Privileges
	'j_turtle_bean',
	'j_vagabond',
	'j_dusk',
	'j_burnt',
	'j_mime',
	'j_perkeo',
	'j_stone',
] as const

export type AvatarId = (typeof AVATAR_IDS)[number]

export const DEFAULT_AVATAR: AvatarId = 'j_joker'

export function isAvatarId(value: unknown): value is AvatarId {
	return typeof value === 'string' && (AVATAR_IDS as readonly string[]).indexOf(value) !== -1
}
