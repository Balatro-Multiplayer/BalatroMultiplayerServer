import { describe, expect, test } from 'bun:test'
import {
  holdsInstantQueue,
  instantQueueAccessError,
  privilegesWithInstantQueue,
} from './instant-queue-access'

describe('instant queue access', () => {
  test('reads the privilege', () => {
    expect(holdsInstantQueue(['tester', 'instaqueue'])).toBe(true)
    expect(holdsInstantQueue(['moderator'])).toBe(false)
  })

  test('a grant or removal leaves the other privileges alone', () => {
    expect(privilegesWithInstantQueue(['moderator'], true)).toEqual([
      'moderator',
      'instaqueue',
    ])
    expect(privilegesWithInstantQueue(['instaqueue'], true)).toEqual([
      'instaqueue',
    ])
    expect(
      privilegesWithInstantQueue(['admin', 'instaqueue', 'tester'], false)
    ).toEqual(['admin', 'tester'])
  })

  test('needs a note', () => {
    expect(instantQueueAccessError('  ')).toBe('A change needs a note.')
    expect(instantQueueAccessError('Handles the top queue')).toBeNull()
  })
})
