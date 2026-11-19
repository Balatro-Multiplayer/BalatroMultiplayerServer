import { describe, expect, test } from 'bun:test'
import { ratingChangeNow, ratingNow } from './beta-seasons'

describe('ratingNow', () => {
  test('maps each season start rating to the current start', () => {
    expect(ratingNow(1, 1000)).toBe(600)
    expect(ratingNow(3, 200)).toBe(600)
    expect(ratingNow(5, 200)).toBe(600)
    expect(ratingNow(7, 500)).toBe(600)
  })

  test('scales the distance from the start by the season scale', () => {
    expect(ratingNow(2, 900)).toBe(1600)
    expect(ratingNow(6, 1400)).toBe(1600)
    expect(ratingNow(7, 1100)).toBe(1100)
  })

  test('keeps the current rating floor', () => {
    expect(ratingNow(2, -20)).toBe(286)
    expect(ratingNow(1, -44)).toBe(100)
  })

  test('leaves an unknown season as is', () => {
    expect(ratingNow(9, 812.4)).toBe(812)
  })
})

describe('ratingChangeNow', () => {
  test('scales a change by the season scale', () => {
    expect(ratingChangeNow(2, 25.5)).toBe(36)
    expect(ratingChangeNow(7, -18)).toBe(-15)
  })
})
