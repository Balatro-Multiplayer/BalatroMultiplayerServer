// How an avatar is unlocked. Each kind names what it reads from a player's
// achievement progress (achievements/progress.ts); unlocked.ts and
// achievements/unlocks.ts are the only places that evaluate them.

// Privileges that grant avatars (players.privileges in the API; free-form
// there, so other privileges simply grant nothing).
export const AVATAR_PRIVILEGES = ['virtualized', 'bean', 'vagabond', 'sizaak', 'lava', 'twelve', 'staff'] as const
export type AvatarPrivilege = (typeof AVATAR_PRIVILEGES)[number]

// Running totals kept per player. bestWinStreak is the best streak so far.
export const COUNTERS = [
	'wins',
	'games',
	'pvpGames',
	'spdrnGames',
	'winsVs3Plus',
	'winsVs7Plus',
	'hands',
	'rerolls',
	'moneySpent',
	'livesLost',
	'skips',
	'suitChangers',
	'smallworldGames',
	'daysPlayed',
	'bestWinStreak',
] as const
export type Counter = (typeof COUNTERS)[number]

// One-off events.
export const MILESTONES = ['discordLinked', 'sub8SpdrnRun', 'scoredOver1e11', 'metShowman'] as const
export type Milestone = (typeof MILESTONES)[number]

// The vanilla decks (modded and challenge decks don't count for any goal).
export const VANILLA_DECKS = [
	'b_red',
	'b_blue',
	'b_yellow',
	'b_green',
	'b_black',
	'b_magic',
	'b_nebula',
	'b_ghost',
	'b_abandoned',
	'b_checkered',
	'b_zodiac',
	'b_painted',
	'b_anaglyph',
	'b_plasma',
	'b_erratic',
] as const
export type VanillaDeck = (typeof VANILLA_DECKS)[number]

// The Speedrun mod's gamemodes (BalatroMultiplayerSpeed domain/gamemode.lua).
export const SPDRN_MODES = [
	'spdrn_white_stake_triple',
	'spdrn_gold_stake_single',
	'spdrn_seed_scout',
	'spdrn_challenge',
	'spdrn_all_deck',
	'spdrn_stake_climb',
] as const
export type SpdrnMode = (typeof SPDRN_MODES)[number]

// Sets a player completes by playing at least one game of each member.
export type Collection = 'vanillaDecks' | 'spdrnModes'

export type ReservedFor = 'future' | 'practice'

export type UnlockRule =
	| { kind: 'default' }
	| { kind: 'privilege'; privilege: AvatarPrivilege }
	| { kind: 'counter'; counter: Counter; threshold: number }
	| { kind: 'deckGames'; deck: VanillaDeck; threshold: number }
	| { kind: 'allOf'; collection: Collection }
	| { kind: 'milestone'; milestone: Milestone }
	// Every avatar a player can earn by playing (counter, deckGames, allOf
	// and milestone rules) other than this one.
	| { kind: 'allUnlockable' }
	| { kind: 'reserved'; reservedFor: ReservedFor }

export function membersOf(collection: Collection): readonly string[] {
	switch (collection) {
		case 'vanillaDecks':
			return VANILLA_DECKS
		case 'spdrnModes':
			return SPDRN_MODES
	}
}

// Rules a player earns through play (what allUnlockable counts).
export function isEarnedByPlay(rule: UnlockRule): boolean {
	return rule.kind === 'counter' || rule.kind === 'deckGames' || rule.kind === 'allOf' || rule.kind === 'milestone'
}
