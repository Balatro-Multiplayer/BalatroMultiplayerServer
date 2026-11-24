// The decks a Ranked Cocktail can mix: the keys the mod's Cocktail knows
// (vanilla decks and the PvP mod's own). The mod refuses a key a player's game
// lacks, so only these are offered.
export const COCKTAIL_DECKS: { key: string; label: string }[] = [
  { key: 'b_red', label: 'Red Deck' },
  { key: 'b_blue', label: 'Blue Deck' },
  { key: 'b_yellow', label: 'Yellow Deck' },
  { key: 'b_green', label: 'Green Deck' },
  { key: 'b_black', label: 'Black Deck' },
  { key: 'b_magic', label: 'Magic Deck' },
  { key: 'b_nebula', label: 'Nebula Deck' },
  { key: 'b_ghost', label: 'Ghost Deck' },
  { key: 'b_abandoned', label: 'Abandoned Deck' },
  { key: 'b_checkered', label: 'Checkered Deck' },
  { key: 'b_zodiac', label: 'Zodiac Deck' },
  { key: 'b_painted', label: 'Painted Deck' },
  { key: 'b_anaglyph', label: 'Anaglyph Deck' },
  { key: 'b_plasma', label: 'Plasma Deck' },
  { key: 'b_erratic', label: 'Erratic Deck' },
  { key: 'b_mp_orange', label: 'Orange Deck' },
  { key: 'b_mp_indigo', label: 'Indigo Deck' },
  { key: 'b_mp_violet', label: 'Violet Deck' },
  { key: 'b_mp_white', label: 'White Deck' },
  { key: 'b_mp_oracle', label: 'Oracle Deck' },
  { key: 'b_mp_gradient', label: 'Gradient Deck' },
  { key: 'b_mp_heidelberg', label: 'Heidelberg Deck' },
  { key: 'b_mp_echodeck', label: 'Echo Deck' },
]

export const MAX_DECKS = 3
export const MAX_NAME = 64

// A fixed mix, or random: the game rolls three decks for every Cocktail tile
// of a game's Draft, under this name (sameEveryTile: one roll per game, for
// every tile).
export type Recipe =
  | { name: string; decks: string[] }
  | { name: string; random: true; sameEveryTile?: true }

export const isRandom = (
  r: Recipe
): r is { name: string; random: true; sameEveryTile?: true } =>
  'random' in r && r.random === true

export const isSameEveryTile = (r: Recipe) =>
  isRandom(r) && r.sameEveryTile === true

export const decksOf = (r: Recipe): string[] => (isRandom(r) ? [] : r.decks)

export const deckLabel = (key: string) =>
  COCKTAIL_DECKS.find((d) => d.key === key)?.label ?? key

// The recipe a draft makes, or why it is not one yet. Empty slots are skipped;
// a random one ignores them.
export function recipeOf(
  name: string,
  slots: string[],
  random = false,
  sameEveryTile = false
): { recipe: Recipe } | { error: string } {
  const decks = slots.filter((k) => k !== '')
  if (!name.trim()) return { error: 'A name is required' }
  if (name.trim().length > MAX_NAME)
    return { error: `The name is over ${MAX_NAME} characters` }
  if (random)
    return {
      recipe: sameEveryTile
        ? { name: name.trim(), random: true, sameEveryTile: true }
        : { name: name.trim(), random: true },
    }
  if (decks.length < 1) return { error: 'Pick at least one deck' }
  if (new Set(decks).size !== decks.length)
    return { error: 'Each deck can be picked once' }
  return { recipe: { name: name.trim(), decks } }
}

export function sameRecipe(a: Recipe | null, b: Recipe): boolean {
  if (
    a === null ||
    a.name !== b.name ||
    isRandom(a) !== isRandom(b) ||
    isSameEveryTile(a) !== isSameEveryTile(b)
  )
    return false
  const da = decksOf(a)
  const db = decksOf(b)
  return da.length === db.length && da.every((d, i) => d === db[i])
}
