import { describe, expect, test } from 'bun:test'
import { staffMenuGroups } from './staff-menu'

const labels = (role: {
  isAdmin: boolean
  isModerator: boolean
  canEditInstantQueue?: boolean
}) =>
  staffMenuGroups(role).map((g) => [g.label, g.items.map((i) => i.label)])

describe('staffMenuGroups', () => {
  test('a player sees no menu', () => {
    expect(staffMenuGroups({ isAdmin: false, isModerator: false })).toEqual([])
  })

  test('a moderator sees the moderation pages and Seasons and Blog', () => {
    expect(labels({ isAdmin: false, isModerator: true })).toEqual([
      [
        'Moderation',
        [
          'Service Queue',
          'Players',
          'Lobbies',
          'Staff Log',
          'Discord Archives',
        ],
      ],
      ['Ops', ['Seasons', 'Blog']],
    ])
  })

  test('an admin sees every page', () => {
    expect(labels({ isAdmin: true, isModerator: false })).toEqual([
      [
        'Moderation',
        [
          'Service Queue',
          'Players',
          'Lobbies',
          'Staff Log',
          'Discord Archives',
        ],
      ],
      [
        'Ops',
        [
          'Seasons',
          'BET Releases',
          'Blog',
          'Configuration',
          'Ranked Mods',
          'Instant Queue',
          'Ranked Cocktail',
        ],
      ],
    ])
  })

  test('a player with the instaqueue privilege sees only Instant Queue', () => {
    expect(
      labels({ isAdmin: false, isModerator: false, canEditInstantQueue: true })
    ).toEqual([['Ops', ['Instant Queue']]])
  })

  test('a moderator with the instaqueue privilege sees it as well', () => {
    const ops = labels({
      isAdmin: false,
      isModerator: true,
      canEditInstantQueue: true,
    })[1]
    expect(ops).toEqual(['Ops', ['Seasons', 'Blog', 'Instant Queue']])
  })

  test('no menu links the removed pages', () => {
    const hrefs = staffMenuGroups({ isAdmin: true, isModerator: true })
      .flatMap((g) => g.items)
      .map((i) => i.href)
    for (const gone of ['/admin/logs', '/admin/games', '/admin/users'])
      expect(hrefs.includes(gone)).toBe(false)
  })
})
