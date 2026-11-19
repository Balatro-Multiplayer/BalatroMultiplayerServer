// Cards merge in the deck viewer when they share suit, value and tags, in any
// tag order.
export function deckCardKey(card: {
  suit: string
  value: string
  tags: readonly string[]
}): string {
  return `${card.suit}|${card.value}|${[...card.tags].sort().join('|')}`
}
