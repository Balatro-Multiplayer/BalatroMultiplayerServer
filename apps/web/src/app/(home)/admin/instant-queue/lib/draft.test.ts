import { describe, expect, test } from 'bun:test'
import {
  changeCount,
  countQuery,
  draftOf,
  parseEdge,
  playersLabel,
  rangeOf,
} from './draft'

const EMPTY = {
  enabled: false,
  floor: null,
  ceiling: null,
  floorMultiplier: 1,
  ceilingMultiplier: 1,
}

describe('parseEdge', () => {
  test('empty is no edge, a whole rating is itself', () => {
    expect(parseEdge('')).toBeNull()
    expect(parseEdge(' 1200 ')).toBe(1200)
    expect(parseEdge('0')).toBe(0)
  })
  test('anything else is refused', () => {
    for (const t of ['12.5', '-3', 'abc', '10001', '1e3'])
      expect(parseEdge(t)).toBe(undefined)
  })
})

describe('rangeOf', () => {
  test('reads a draft', () => {
    expect(
      rangeOf({
        enabled: true,
        floor: '1200',
        ceiling: '400',
        floorMultiplier: '1.5',
        ceilingMultiplier: '1',
      })
    ).toEqual({
      range: {
        enabled: true,
        floor: 1200,
        ceiling: 400,
        floorMultiplier: 1.5,
        ceilingMultiplier: 1,
      },
    })
    expect(rangeOf(draftOf(EMPTY))).toEqual({ range: EMPTY })
  })
  test('names what is wrong', () => {
    const base = draftOf(EMPTY)
    expect('error' in rangeOf({ ...base, floor: 'x' })).toBe(true)
    expect('error' in rangeOf({ ...base, floorMultiplier: '0' })).toBe(true)
    expect('error' in rangeOf({ ...base, ceilingMultiplier: '11' })).toBe(true)
    expect('error' in rangeOf({ ...base, floor: '500', ceiling: '500' })).toBe(
      true
    )
  })
})

describe('changeCount', () => {
  test('counts edges, and multipliers only of a set edge', () => {
    expect(changeCount(EMPTY, EMPTY)).toBe(0)
    expect(changeCount(EMPTY, { ...EMPTY, floor: 1200 })).toBe(1)
    expect(changeCount(EMPTY, { ...EMPTY, enabled: true })).toBe(1)
    expect(changeCount(EMPTY, { ...EMPTY, floorMultiplier: 2 })).toBe(0)
    expect(
      changeCount(EMPTY, {
        enabled: false,
        floor: 1200,
        ceiling: 400,
        floorMultiplier: 2,
        ceilingMultiplier: 1,
      })
    ).toBe(3)
  })
})

describe('playersLabel', () => {
  test('is the count of players', () => {
    expect(playersLabel(1)).toBe('1 player')
    expect(playersLabel(100)).toBe('100 players')
    expect(playersLabel(0)).toBe('0 players')
    expect(playersLabel(null)).toBe('')
  })
})

describe('countQuery', () => {
  test('asks for the edges that are set and valid', () => {
    const base = draftOf(EMPTY)
    expect(countQuery('M', 'std', base)).toBeNull()
    expect(countQuery('M', 'std', { ...base, floor: '1200' })).toBe(
      'modId=M&gameMode=std&floor=1200'
    )
    expect(
      countQuery('M', 'std', { ...base, floor: '1200', ceiling: '400' })
    ).toBe('modId=M&gameMode=std&floor=1200&ceiling=400')
    expect(countQuery('M', 'std', { ...base, floor: '12x' })).toBeNull()
  })
})
