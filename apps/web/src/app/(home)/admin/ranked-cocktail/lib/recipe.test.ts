import { describe, expect, it } from 'bun:test'
import { recipeOf, sameRecipe } from './recipe'

describe('recipeOf', () => {
  it('skips empty slots and trims the name', () => {
    expect(recipeOf('  Sample ', ['b_red', '', 'b_blue'])).toEqual({
      recipe: { name: 'Sample', decks: ['b_red', 'b_blue'] },
    })
  })
  it('needs a name and a deck, and no repeats', () => {
    expect(recipeOf('', ['b_red'])).toHaveProperty('error')
    expect(recipeOf('x', ['', '', ''])).toHaveProperty('error')
    expect(recipeOf('x', ['b_red', 'b_red', ''])).toHaveProperty('error')
    expect(recipeOf('x'.repeat(65), ['b_red'])).toHaveProperty('error')
  })
})

describe('sameRecipe', () => {
  const r = { name: 'A', decks: ['b_red', 'b_blue'] }
  it('compares name and deck order', () => {
    expect(sameRecipe(r, { ...r, decks: [...r.decks] })).toBe(true)
    expect(sameRecipe(r, { ...r, decks: ['b_blue', 'b_red'] })).toBe(false)
    expect(sameRecipe(null, r)).toBe(false)
  })
})
