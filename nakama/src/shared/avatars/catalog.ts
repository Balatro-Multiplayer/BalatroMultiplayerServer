// The avatar sheet: what unlocks each avatar. Keyed by AvatarId, so the
// compiler holds every id to exactly one entry; CATALOG lists them in
// AVATAR_IDS order (the order the client shows them).
import { AVATAR_IDS, type AvatarId } from './ids'
import type { AvatarPrivilege, UnlockRule } from './rules'

export interface CatalogEntry {
	id: AvatarId
	rule: UnlockRule
	// A privilege that grants the avatar without earning it.
	alsoGrantedBy?: AvatarPrivilege
}

type Sheet = { [id in AvatarId]: Omit<CatalogEntry, 'id'> }

const DEFAULT: Omit<CatalogEntry, 'id'> = { rule: { kind: 'default' } }
const counter = (counter: Extract<UnlockRule, { kind: 'counter' }>['counter'], threshold: number) => ({
	rule: { kind: 'counter', counter, threshold } as UnlockRule,
})
const privilege = (privilege: AvatarPrivilege) => ({ rule: { kind: 'privilege', privilege } as UnlockRule })

const SHEET: Sheet = {
	j_joker: DEFAULT,
	j_jolly: DEFAULT,
	j_zany: DEFAULT,
	j_mad: DEFAULT,
	j_crazy: DEFAULT,
	j_droll: DEFAULT,
	j_sly: DEFAULT,
	j_wily: DEFAULT,
	j_clever: DEFAULT,
	j_devious: DEFAULT,
	j_crafty: DEFAULT,

	j_baron: counter('wins', 1),
	j_lucky_cat: counter('wins', 10),
	j_smiley: counter('wins', 50),
	j_midas_mask: counter('wins', 100),

	j_swashbuckler: counter('games', 5),
	j_vampire: counter('games', 10),
	j_photograph: counter('games', 50),
	j_square: counter('games', 64),
	j_scary_face: counter('games', 100),
	j_madness: counter('games', 200),

	j_odd_todd: counter('daysPlayed', 7),
	j_even_steven: counter('daysPlayed', 14),
	j_ancient: counter('daysPlayed', 30),

	j_fortune_teller: counter('bestWinStreak', 3),
	j_sixth_sense: counter('bestWinStreak', 5),

	j_faceless: counter('pvpGames', 10),
	j_bull: counter('pvpGames', 25),
	j_card_sharp: counter('pvpGames', 50),

	j_space: counter('spdrnGames', 10),
	j_astronomer: counter('spdrnGames', 25),
	j_constellation: counter('spdrnGames', 50),

	j_runner: { rule: { kind: 'milestone', milestone: 'sub8SpdrnRun' } },
	j_hiker: { rule: { kind: 'allOf', collection: 'spdrnModes' } },

	j_idol: { rule: { kind: 'allOf', collection: 'vanillaDecks' } },
	j_luchador: counter('winsVs3Plus', 1),
	j_matador: counter('winsVs7Plus', 1),
	j_scholar: { rule: { kind: 'milestone', milestone: 'discordLinked' } },
	j_stuntman: { rule: { kind: 'milestone', milestone: 'scoredOver1e11' } },
	j_wee: counter('smallworldGames', 10),
	j_burglar: counter('hands', 1000),
	j_chaos: counter('rerolls', 100),
	j_egg: counter('moneySpent', 3000),
	j_mr_bones: counter('livesLost', 100),
	j_ring_master: { rule: { kind: 'milestone', milestone: 'metShowman' }, alsoGrantedBy: 'staff' },
	j_pareidolia: { rule: { kind: 'allUnlockable' } },
	j_throwback: counter('skips', 100),
	j_blue_joker: { rule: { kind: 'deckGames', deck: 'b_blue', threshold: 10 } },
	j_green_joker: { rule: { kind: 'deckGames', deck: 'b_green', threshold: 3 } },
	j_golden: { rule: { kind: 'deckGames', deck: 'b_yellow', threshold: 3 } },
	j_smeared: counter('suitChangers', 100),

	j_troubadour: { rule: { kind: 'reserved', reservedFor: 'future' } },
	j_blueprint: { rule: { kind: 'reserved', reservedFor: 'future' } },
	j_merry_andy: { rule: { kind: 'reserved', reservedFor: 'future' } },
	j_brainstorm: { rule: { kind: 'reserved', reservedFor: 'future' } },
	j_abstract: { rule: { kind: 'reserved', reservedFor: 'practice' } },

	j_turtle_bean: privilege('bean'),
	j_vagabond: privilege('vagabond'),
	j_dusk: privilege('sizaak'),
	j_burnt: privilege('lava'),
	j_mime: privilege('staff'),
	j_perkeo: privilege('virtualized'),
	j_stone: privilege('twelve'),
}

export const CATALOG: readonly CatalogEntry[] = AVATAR_IDS.map((id) => ({ id, ...SHEET[id] }))

export function entryOf(id: AvatarId): CatalogEntry {
	return { id, ...SHEET[id] }
}
