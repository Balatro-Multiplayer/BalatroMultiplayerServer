import { describe, expect, it } from 'vitest'
import { CATALOG, entryOf } from './catalog'
import { AVATAR_IDS, DEFAULT_AVATAR, isAvatarId } from './ids'
import { isEarnedByPlay } from './rules'
import { isSelectable, NO_HOLDINGS, privilegeTable, selectableAvatars, selectableOrDefault } from './unlocked'

const ruleOf = (id: string) => entryOf(id as any).rule

describe('avatar catalog', () => {
	it('lists every avatar once', () => {
		const ids = CATALOG.map((e) => e.id)
		expect(ids).toEqual([...AVATAR_IDS])
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids).toHaveLength(63)
	})

	it('has the 11 defaults, the default avatar first', () => {
		const defaults = CATALOG.filter((e) => e.rule.kind === 'default').map((e) => e.id)
		expect(defaults).toEqual(['j_joker', 'j_jolly', 'j_zany', 'j_mad', 'j_crazy', 'j_droll', 'j_sly', 'j_wily', 'j_clever', 'j_devious', 'j_crafty'])
		expect(DEFAULT_AVATAR).toBe('j_joker')
	})

	it('matches the sheet', () => {
		const counter = (counter: string, threshold: number) => ({ kind: 'counter', counter, threshold })
		const sheet: [string, object][] = [
			['j_baron', counter('wins', 1)],
			['j_lucky_cat', counter('wins', 10)],
			['j_smiley', counter('wins', 50)],
			['j_midas_mask', counter('wins', 100)],
			['j_swashbuckler', counter('games', 5)],
			['j_vampire', counter('games', 10)],
			['j_photograph', counter('games', 50)],
			['j_square', counter('games', 64)],
			['j_scary_face', counter('games', 100)],
			['j_madness', counter('games', 200)],
			['j_odd_todd', counter('daysPlayed', 7)],
			['j_even_steven', counter('daysPlayed', 14)],
			['j_ancient', counter('daysPlayed', 30)],
			['j_fortune_teller', counter('bestWinStreak', 3)],
			['j_sixth_sense', counter('bestWinStreak', 5)],
			['j_faceless', counter('pvpGames', 10)],
			['j_bull', counter('pvpGames', 25)],
			['j_card_sharp', counter('pvpGames', 50)],
			['j_space', counter('spdrnGames', 10)],
			['j_astronomer', counter('spdrnGames', 25)],
			['j_constellation', counter('spdrnGames', 50)],
			['j_runner', { kind: 'milestone', milestone: 'sub8SpdrnRun' }],
			['j_hiker', { kind: 'allOf', collection: 'spdrnModes' }],
			['j_idol', { kind: 'allOf', collection: 'vanillaDecks' }],
			['j_luchador', counter('winsVs3Plus', 1)],
			['j_matador', counter('winsVs7Plus', 1)],
			['j_scholar', { kind: 'milestone', milestone: 'discordLinked' }],
			['j_stuntman', { kind: 'milestone', milestone: 'scoredOver1e11' }],
			['j_wee', counter('smallworldGames', 10)],
			['j_burglar', counter('hands', 1000)],
			['j_chaos', counter('rerolls', 100)],
			['j_egg', counter('moneySpent', 3000)],
			['j_mr_bones', counter('livesLost', 100)],
			['j_ring_master', { kind: 'milestone', milestone: 'metShowman' }],
			['j_pareidolia', { kind: 'allUnlockable' }],
			['j_throwback', counter('skips', 100)],
			['j_blue_joker', { kind: 'deckGames', deck: 'b_blue', threshold: 10 }],
			['j_green_joker', { kind: 'deckGames', deck: 'b_green', threshold: 3 }],
			['j_golden', { kind: 'deckGames', deck: 'b_yellow', threshold: 3 }],
			['j_smeared', counter('suitChangers', 100)],
			['j_troubadour', { kind: 'reserved', reservedFor: 'coop' }],
			['j_blueprint', { kind: 'reserved', reservedFor: 'coop' }],
			['j_merry_andy', { kind: 'reserved', reservedFor: 'coop' }],
			['j_brainstorm', { kind: 'reserved', reservedFor: 'coop' }],
			['j_abstract', { kind: 'reserved', reservedFor: 'practice' }],
			['j_turtle_bean', { kind: 'privilege', privilege: 'bean' }],
			['j_vagabond', { kind: 'privilege', privilege: 'vagabond' }],
			['j_dusk', { kind: 'privilege', privilege: 'sizaak' }],
			['j_burnt', { kind: 'privilege', privilege: 'lava' }],
			['j_mime', { kind: 'privilege', privilege: 'staff' }],
			['j_perkeo', { kind: 'privilege', privilege: 'virtualized' }],
			['j_stone', { kind: 'privilege', privilege: 'twelve' }],
		]
		for (const [id, rule] of sheet) expect(ruleOf(id), id).toEqual(rule)
		expect(sheet.length + 11).toBe(CATALOG.length)
		expect(entryOf('j_ring_master').alsoGrantedBy).toBe('staff')
		expect(CATALOG.filter((e) => e.alsoGrantedBy).map((e) => e.id)).toEqual(['j_ring_master'])
	})

	it('knows only catalog ids', () => {
		expect(isAvatarId('j_joker')).toBe(true)
		expect(isAvatarId('j_cavendish')).toBe(false)
		expect(isAvatarId(7)).toBe(false)
	})

	it('has 39 avatars earned through play (all but defaults, privileges, reserved and Pareidolia)', () => {
		expect(CATALOG.filter((e) => isEarnedByPlay(e.rule))).toHaveLength(39)
	})
})

describe('selectable avatars', () => {
	it('offers the defaults to everyone', () => {
		expect(selectableAvatars(NO_HOLDINGS)).toHaveLength(11)
		expect(isSelectable('j_crafty', NO_HOLDINGS)).toBe(true)
		expect(isSelectable('j_baron', NO_HOLDINGS)).toBe(false)
		expect(isSelectable('j_nope', NO_HOLDINGS)).toBe(false)
	})

	it('offers privilege avatars with the privilege only, even if listed as earned', () => {
		expect(isSelectable('j_turtle_bean', { privileges: ['bean'], unlocked: [] })).toBe(true)
		expect(isSelectable('j_turtle_bean', { privileges: [], unlocked: ['j_turtle_bean'] })).toBe(false)
		expect(isSelectable('j_blueprint', { privileges: ['staff', 'admin'], unlocked: ['j_blueprint'] })).toBe(false)
	})

	it('grants Mime and Showman to staff, and Showman to whoever earned it', () => {
		const staff = { privileges: ['staff'], unlocked: [] }
		expect(isSelectable('j_mime', staff)).toBe(true)
		expect(isSelectable('j_ring_master', staff)).toBe(true)
		expect(isSelectable('j_ring_master', { privileges: [], unlocked: ['j_ring_master'] })).toBe(true)
		expect(privilegeTable(['staff'])).toEqual({ jokers: ['j_ring_master', 'j_mime'] })
		expect(privilegeTable(['virtualized', 'admin'])).toEqual({ jokers: ['j_perkeo'] })
		expect(privilegeTable(['admin'])).toEqual({})
	})

	it('falls back to the default avatar', () => {
		expect(selectableOrDefault('j_baron', NO_HOLDINGS)).toBe('j_joker')
		expect(selectableOrDefault('j_baron', { privileges: [], unlocked: ['j_baron'] })).toBe('j_baron')
		expect(selectableOrDefault(undefined, NO_HOLDINGS)).toBe('j_joker')
	})
})
