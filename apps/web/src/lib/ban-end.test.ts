import { describe, expect, test } from 'bun:test'
import { banEndText, startsOnLogin } from './ban-end'

const format = (iso: string) => `at ${iso}`

describe('banEndText', () => {
  test('shows the end once the clock has started', () => {
    expect(banEndText({ expiresAt: '2026-06-02', durationMs: 1 }, format)).toBe(
      'at 2026-06-02'
    )
  })

  test('says a timed ban starts at the next login until then', () => {
    const ban = { expiresAt: null, durationMs: 86_400_000 }
    expect(startsOnLogin(ban)).toBe(true)
    expect(banEndText(ban, format)).toBe('starts when the player next logs in')
  })

  test('calls a ban with no end and no length permanent', () => {
    expect(banEndText({ expiresAt: null, durationMs: null }, format)).toBe(
      'permanent'
    )
    expect(banEndText({ expiresAt: null }, format)).toBe('permanent')
  })
})
