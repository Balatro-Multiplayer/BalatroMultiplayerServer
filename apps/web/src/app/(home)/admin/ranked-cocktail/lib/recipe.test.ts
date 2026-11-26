import { describe, expect, test } from 'bun:test'
import { recipeOf, sameRecipe } from './recipe'

describe('recipeOf', () => {
  test('skips empty slots and trims the name', () => {
    expect(recipeOf('  Sample ', ['b_red', '', 'b_blue'])).toEqual({
      recipe: { name: 'Sample', decks: ['b_red', 'b_blue'] },
    })
  })
  test('needs a name and a deck, and no repeats', () => {
    expect('error' in recipeOf('', ['b_red'])).toBe(true)
    expect('error' in recipeOf('x', ['', '', ''])).toBe(true)
    expect('error' in recipeOf('x', ['b_red', 'b_red', ''])).toBe(true)
    expect('error' in recipeOf('x'.repeat(65), ['b_red'])).toBe(true)
  })
  test('makes a random one from the name alone', () => {
    expect(recipeOf(' Mystery ', ['b_red', '', ''], true)).toEqual({
      recipe: { name: 'Mystery', random: true },
    })
    expect('error' in recipeOf('', [], true)).toBe(true)
    expect(recipeOf('Mystery', [], true, true)).toEqual({
      recipe: { name: 'Mystery', random: true, sameEveryTile: true },
    })
    expect(recipeOf('x', ['b_red'], false, true)).toEqual({
      recipe: { name: 'x', decks: ['b_red'] },
    })
  })
})

describe('sameRecipe', () => {
  const r = { name: 'A', decks: ['b_red', 'b_blue'] }
  test('compares name and deck order', () => {
    expect(sameRecipe(r, { ...r, decks: [...r.decks] })).toBe(true)
    expect(sameRecipe(r, { ...r, decks: ['b_blue', 'b_red'] })).toBe(false)
    expect(sameRecipe(null, r)).toBe(false)
  })
  test('tells random from fixed', () => {
    const random = { name: 'A', random: true as const }
    expect(sameRecipe(random, { name: 'A', random: true })).toBe(true)
    expect(sameRecipe(random, r)).toBe(false)
    expect(sameRecipe(r, random)).toBe(false)
    expect(sameRecipe(random, { ...random, sameEveryTile: true })).toBe(false)
  })
})
