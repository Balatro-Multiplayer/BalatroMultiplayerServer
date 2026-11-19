import { expect, test } from 'bun:test'
import { deckCardKey } from './deck-card-key'

test('tag order does not change the key', () => {
  const a = { suit: 'Hearts', value: 'King', tags: ['e:m_glass', 's:Red'] }
  const b = { suit: 'Hearts', value: 'King', tags: ['s:Red', 'e:m_glass'] }
  expect(deckCardKey(a)).toBe(deckCardKey(b))
})

test('different tags give different keys', () => {
  const a = { suit: 'Hearts', value: 'King', tags: ['ed:foil'] }
  const b = { suit: 'Hearts', value: 'King', tags: [] }
  expect(deckCardKey(a) === deckCardKey(b)).toBe(false)
})
