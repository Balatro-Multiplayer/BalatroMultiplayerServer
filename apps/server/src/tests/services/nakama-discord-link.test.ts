import { describe, expect, it, vi } from 'vitest'
import { createDiscordLinkService } from '../../features/nakama/discord-link.service.js'
import { hashProviderId } from '../../shared/utils/hash.js'
import { err, ok } from '../../shared/utils/result.js'

const NAKAMA_ID = '11111111-1111-4111-8111-111111111111'

function deps(over: { player?: any; holder?: any; rpc?: any } = {}) {
	return {
		players: {
			findPlayerByNakamaUserId: vi.fn().mockResolvedValue(over.player ?? null),
			findPlayerByDiscordIdHash: vi.fn().mockResolvedValue(over.holder ?? null),
			linkDiscord: vi.fn().mockResolvedValue(undefined),
			unlinkDiscord: vi.fn().mockResolvedValue(undefined),
		},
		callNakamaRpc: vi.fn().mockResolvedValue(over.rpc ?? ok({})),
	}
}

describe('linkNakamaDiscord', () => {
	it('links on Nakama, then on the player row', async () => {
		const d = deps({ player: { id: 'p1' } })
		expect(await createDiscordLinkService(d).linkNakamaDiscord(NAKAMA_ID, 'd1', 'alice')).toBe('linked')
		expect(d.callNakamaRpc).toHaveBeenCalledWith('admin_discord_set', {
			userId: NAKAMA_ID,
			discordIdHash: hashProviderId('d1'),
			discordUsername: 'alice',
		})
		expect(d.players.linkDiscord).toHaveBeenCalledWith('p1', hashProviderId('d1'), 'alice')
	})

	it('refuses a Discord account another player row holds', async () => {
		const d = deps({ player: { id: 'p1' }, holder: { id: 'p2' } })
		expect(await createDiscordLinkService(d).linkNakamaDiscord(NAKAMA_ID, 'd1', 'alice')).toBe('linked_elsewhere')
		expect(d.callNakamaRpc).not.toHaveBeenCalled()
	})

	it('relinks the player\'s own Discord', async () => {
		const d = deps({ player: { id: 'p1' }, holder: { id: 'p1' } })
		expect(await createDiscordLinkService(d).linkNakamaDiscord(NAKAMA_ID, 'd1', 'alice')).toBe('linked')
	})

	it('maps Nakama refusing it', async () => {
		expect(await createDiscordLinkService(deps({ rpc: err('conflict') })).linkNakamaDiscord(NAKAMA_ID, 'd1', 'a')).toBe(
			'linked_elsewhere',
		)
		const down = deps({ player: { id: 'p1' }, rpc: err('unreachable') })
		expect(await createDiscordLinkService(down).linkNakamaDiscord(NAKAMA_ID, 'd1', 'a')).toBe('unavailable')
		expect(down.players.linkDiscord).not.toHaveBeenCalled()
	})

	it('links a player with no player row on Nakama only', async () => {
		const d = deps()
		expect(await createDiscordLinkService(d).linkNakamaDiscord(NAKAMA_ID, 'd1', 'a')).toBe('linked')
		expect(d.players.linkDiscord).not.toHaveBeenCalled()
	})
})

describe('unlinkNakamaDiscord', () => {
	it('clears the player row', async () => {
		const d = deps({ player: { id: 'p1' } })
		await createDiscordLinkService(d).unlinkNakamaDiscord(NAKAMA_ID)
		expect(d.players.unlinkDiscord).toHaveBeenCalledWith('p1')
	})
})
