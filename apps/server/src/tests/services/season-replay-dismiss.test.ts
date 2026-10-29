import { describe, expect, it } from 'vitest'
import { dismissAntiCheatItems } from '../../features/ratings/season-replay-dismiss.js'

describe('dismissAntiCheatItems', () => {
	it('dismisses each open item as the owner with the note, and counts failures', async () => {
		const dismissed: unknown[] = []
		const result = await dismissAntiCheatItems(['run-1'], 'note', 'owner-1', {
			listOpenItems: async (runIds) => (runIds[0] === 'run-1' ? [1, 2, 3] : []),
			dismiss: async (id, actor, note) => {
				dismissed.push([id, actor, note])
				return { ok: id !== 2 }
			},
		})
		expect(result).toEqual({ dismissed: 2, failed: 1 })
		expect(dismissed).toEqual([
			[1, { playerId: 'owner-1', role: 'admin' }, 'note'],
			[2, { playerId: 'owner-1', role: 'admin' }, 'note'],
			[3, { playerId: 'owner-1', role: 'admin' }, 'note'],
		])
	})
})
