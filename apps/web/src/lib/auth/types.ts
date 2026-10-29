import type { Privilege } from '@bmp/types'

export interface Player {
  id: string
  displayName: string
  steamName: string
  useDiscordName: boolean
  preferredJoker: string | null
  discordLinked: boolean
  discordUsername: string | null
  privileges: Privilege[]
  // Set by the API; the real owner check is on the API route.
  isOwner?: boolean
  chatEnabled: boolean
  chatBlocked: boolean
}
