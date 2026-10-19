// What GET /auth/jokers answers (Nakama's admin_avatars_for, see
// nakama/src/achievements/rpc.ts) and how the profile page words each goal.

export interface AvatarGoal {
  kind: 'counter' | 'deckGames' | 'allOf' | 'milestone' | 'allUnlockable' | 'privilege' | 'reserved'
  key: string
  threshold: number
  progress: number
}

export interface AvatarEntry {
  id: string
  unlocked: boolean
  goal: AvatarGoal | null
}

export interface AvatarCatalog {
  avatars: AvatarEntry[]
  selected: string
  // Whether games count toward goals right now.
  enabled: boolean
  jokers: string[]
}

const COUNTER_GOALS: { [counter: string]: (n: number) => string } = {
  wins: (n) => (n === 1 ? 'Win a game' : `Win ${n} games`),
  games: (n) => `Play ${n} games`,
  pvpGames: (n) => `Play ${n} PvP games`,
  spdrnGames: (n) => `Play ${n} Speedrun games`,
  winsVs3Plus: () => 'Win a game against 3 or more players',
  winsVs7Plus: () => 'Win a game against 7 or more players',
  hands: (n) => `Play ${n} hands`,
  rerolls: (n) => `Reroll the shop ${n} times`,
  moneySpent: (n) => `Spend $${n}`,
  livesLost: (n) => `Lose ${n} lives`,
  skips: (n) => `Skip ${n} blinds`,
  suitChangers: (n) => `Use ${n} suit-changing cards`,
  smallworldGames: (n) => `Play ${n} Small World games`,
  daysPlayed: (n) => `Play on ${n} different days`,
  bestWinStreak: (n) => `Win ${n} games in a row`,
}

const MILESTONE_GOALS: { [milestone: string]: string } = {
  discordLinked: 'Link your Discord account',
  sub8SpdrnRun: 'Finish a Speedrun run in under 8 minutes',
  scoredOver1e11: 'Score over 100 billion with one hand',
  metShowman: 'Play against someone showing Showman',
}

const COLLECTION_GOALS: { [collection: string]: string } = {
  vanillaDecks: 'Play a game with every vanilla deck',
  spdrnModes: 'Play every Speedrun mode',
}

// "b_blue" -> "Blue Deck"
function deckName(key: string): string {
  const name = key.replace(/^b_/, '')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} Deck`
}

export function goalText(goal: AvatarGoal): string {
  switch (goal.kind) {
    case 'counter':
      return COUNTER_GOALS[goal.key]?.(goal.threshold) ?? goal.key
    case 'deckGames':
      return `Play ${goal.threshold} games with the ${deckName(goal.key)}`
    case 'allOf':
      return COLLECTION_GOALS[goal.key] ?? goal.key
    case 'milestone':
      return MILESTONE_GOALS[goal.key] ?? goal.key
    case 'allUnlockable':
      return 'Unlock every other avatar'
    case 'privilege':
      return 'Granted to special players'
    case 'reserved':
      return 'Coming with a future game mode'
  }
}

// Progress worth showing as a count: goals with more than one step.
export function shownProgress(goal: AvatarGoal): string | null {
  if (goal.threshold <= 1 || goal.kind === 'privilege' || goal.kind === 'reserved') return null
  return `${Math.min(goal.progress, goal.threshold)} / ${goal.threshold}`
}
