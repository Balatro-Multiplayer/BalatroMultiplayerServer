// The staff menu: one list that the desktop dropdown and the mobile menu
// both render. Admin-only pages are left out for a moderator.
export interface StaffMenuItem {
  href: string
  label: string
  // The item shows the open queue item count.
  showsQueueCount?: boolean
}

export interface StaffMenuGroup {
  label: string
  items: StaffMenuItem[]
}

interface StaffRole {
  isAdmin: boolean
  isModerator: boolean
  // Holds the 'instaqueue' privilege (an admin always may).
  canEditInstantQueue?: boolean
}

interface Entry extends StaffMenuItem {
  adminOnly?: boolean
  // Open to the 'instaqueue' privilege as well as to admins, staff or not.
  instantQueue?: boolean
}

const MODERATION: Entry[] = [
  {
    href: '/admin/service-queue',
    label: 'Service Queue',
    showsQueueCount: true,
  },
  { href: '/admin/players', label: 'Players' },
  { href: '/admin/lobbies', label: 'Lobbies' },
  { href: '/admin/staff-log', label: 'Staff Log' },
  { href: '/admin/archives', label: 'Discord Archives' },
]

const OPS: Entry[] = [
  { href: '/admin/seasons', label: 'Seasons' },
  { href: '/admin/releases', label: 'BET Releases', adminOnly: true },
  { href: '/admin/blog', label: 'Blog' },
  { href: '/admin/config', label: 'Configuration', adminOnly: true },
  { href: '/admin/ranked-mods', label: 'Ranked Mods', adminOnly: true },
  { href: '/admin/instant-queue', label: 'Instant Queue', instantQueue: true },
  { href: '/admin/ranked-cocktail', label: 'Ranked Cocktail', adminOnly: true },
]

export function staffMenuGroups({
  isAdmin,
  isModerator,
  canEditInstantQueue = false,
}: StaffRole): StaffMenuGroup[] {
  const isStaff = isAdmin || isModerator
  if (!isStaff && !canEditInstantQueue) return []
  const visible = (entries: Entry[]): StaffMenuItem[] =>
    entries
      .filter((e) =>
        e.instantQueue
          ? isAdmin || canEditInstantQueue
          : isStaff && (isAdmin || !e.adminOnly)
      )
      .map(({ adminOnly: _adminOnly, instantQueue: _instantQueue, ...item }) => item)
  return [
    { label: 'Moderation', items: visible(MODERATION) },
    { label: 'Ops', items: visible(OPS) },
  ].filter((group) => group.items.length > 0)
}
