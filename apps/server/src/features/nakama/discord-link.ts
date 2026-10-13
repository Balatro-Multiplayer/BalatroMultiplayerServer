import * as playerGateway from '../../infrastructure/gateways/player.gateway.js'
import { callNakamaRpc } from '../../infrastructure/nakama/admin-client.js'
import { createDiscordLinkService } from './discord-link.service.js'

export const discordLinkService = createDiscordLinkService({ players: playerGateway, callNakamaRpc })
