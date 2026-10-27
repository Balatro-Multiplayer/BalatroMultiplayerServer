// The Find Game pillars the Stats page shows live queue counts for, in pillar
// order, with the game mode key Nakama's queue_counts reports them under.
// Mirrors PvP's ui/main_menu/find_game.lua and SPDRN's
// ui/main_menu/game_select.lua: the server has no list of game modes, so
// change this list whenever a mod changes its pillars.

export interface QueuePillar {
  label: string
  /** queue_counts game mode key (ranked keys carry `ranked:`); null: no queue yet, shows 0 / 0. */
  key: string | null
}

export interface QueuePillarGroup {
  label: 'Ranked' | 'Casual'
  pillars: QueuePillar[]
}

export interface QueueMod {
  modId: 'MultiplayerPvP' | 'MultiplayerSPDRN'
  label: string
  groups: QueuePillarGroup[]
}

export const QUEUE_MODS: QueueMod[] = [
  {
    modId: 'MultiplayerPvP',
    label: 'PvP',
    groups: [
      {
        label: 'Ranked',
        pillars: [
          { label: 'Vanilla Ranked', key: 'ranked:pvp_ranked_vanilla' },
          { label: 'Balanced Ranked', key: 'ranked:pvp_ranked_balanced' },
          { label: 'Expanded Ranked', key: 'ranked:pvp_ranked_expanded' },
          { label: 'MLBa Ranked', key: null },
          { label: 'Smallworld Ranked', key: 'ranked:pvp_ranked_smallworld' },
        ],
      },
      {
        label: 'Casual',
        pillars: [
          { label: 'Nemesis', key: 'pvp_nemesis' },
          { label: 'Battle Royale', key: 'pvp_royale' },
          { label: 'Teams', key: 'pvp_teams' },
          { label: 'Smallworld', key: 'pvp_smallworld' },
        ],
      },
    ],
  },
  {
    modId: 'MultiplayerSPDRN',
    label: 'Speedrunning',
    groups: [
      {
        label: 'Ranked',
        pillars: [
          { label: 'White Stake Triple Ranked', key: 'ranked:spdrn_white_stake_triple' },
          { label: 'Gold Stake Single Ranked', key: 'ranked:spdrn_gold_stake_single' },
        ],
      },
      {
        label: 'Casual',
        pillars: [
          { label: 'White Stake Triple', key: 'spdrn_white_stake_triple' },
          { label: 'Gold Stake Single', key: 'spdrn_gold_stake_single' },
        ],
      },
    ],
  },
]

export interface GameModeCounts {
  queued: number
  inMatch: number
}

/** GET /stats/queues: per mod, the counts by game mode key, or null when Nakama did not answer. */
export type QueueStatsResponse = Record<QueueMod['modId'], Record<string, GameModeCounts> | null>

export function pillarCounts(
  counts: Record<string, GameModeCounts>,
  pillar: QueuePillar,
): GameModeCounts {
  return (pillar.key && counts[pillar.key]) || { queued: 0, inMatch: 0 }
}
