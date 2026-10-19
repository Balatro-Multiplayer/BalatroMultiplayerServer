// The vanilla deck a logged deck value names. Logs carry decks three ways:
// PvP logs the deck's name ("Red Deck"), the Speedrun mod its key ("b_ghost")
// or a table ({key: "b_anaglyph", stake: 2}). Challenge decks (b_challenge)
// and modded decks name no vanilla deck. Pure.
import { VANILLA_DECKS, type VanillaDeck } from '../../shared/avatars/rules'

const DECK_NAMES: { [name: string]: VanillaDeck } = {
	'Red Deck': 'b_red',
	'Blue Deck': 'b_blue',
	'Yellow Deck': 'b_yellow',
	'Green Deck': 'b_green',
	'Black Deck': 'b_black',
	'Magic Deck': 'b_magic',
	'Nebula Deck': 'b_nebula',
	'Ghost Deck': 'b_ghost',
	'Abandoned Deck': 'b_abandoned',
	'Checkered Deck': 'b_checkered',
	'Zodiac Deck': 'b_zodiac',
	'Painted Deck': 'b_painted',
	'Anaglyph Deck': 'b_anaglyph',
	'Plasma Deck': 'b_plasma',
	'Erratic Deck': 'b_erratic',
}

export function deckKeyOf(value: unknown): VanillaDeck | null {
	if (typeof value === 'string') {
		if ((VANILLA_DECKS as readonly string[]).indexOf(value) !== -1) return value as VanillaDeck
		return DECK_NAMES[value] ?? null
	}
	if (value !== null && typeof value === 'object' && !Array.isArray(value))
		return deckKeyOf((value as { key?: unknown }).key)
	return null
}
