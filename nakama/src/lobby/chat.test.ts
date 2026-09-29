import { describe, expect, it } from 'vitest'
import { CHAT_BURST, chatCheck, chatPost } from './chat'
import { ServerOp } from './protocol'
import { join, newLobby } from './state'

function lobbyOf(...ids: string[]) {
	let lobby = newLobby({ code: 'ABC123', modId: 'm', maxPlayers: 4, creatorId: ids[0], now: 0, graceMs: 1000 })
	for (const id of ids)
		lobby = join(lobby, id, id + '-s', { displayName: id.toUpperCase(), preferredJoker: null, mods: null }).lobby
	return lobby
}

describe('chatCheck', () => {
	it('lets a seated player talk and gives their display name', () => {
		const check = chatCheck(lobbyOf('a', 'b'), 'a', 0)
		expect(check).toMatchObject({ ok: true, displayName: 'A', context: [] })
	})
	it('refuses someone who is not seated', () => {
		expect(chatCheck(lobbyOf('a'), 'x', 0)).toEqual({ ok: false, reason: 'not_in_lobby' })
	})
	it('rate limits after a burst and refills over time', () => {
		let lobby = lobbyOf('a', 'b')
		for (let i = 0; i < CHAT_BURST; i++) {
			const check = chatCheck(lobby, 'a', 0)
			expect(check.ok).toBe(true)
			if (check.ok) lobby = check.lobby
		}
		expect(chatCheck(lobby, 'a', 0)).toEqual({ ok: false, reason: 'rate_limited' })
		expect(chatCheck(lobby, 'a', 1500).ok).toBe(true)
		// Another player's bucket is separate.
		expect(chatCheck(lobby, 'b', 0).ok).toBe(true)
	})
})

describe('chatPost', () => {
	it('sends the line to everyone seated, the sender included', () => {
		const step = chatPost(lobbyOf('a', 'b'), 'a', 'hello')
		expect(step.out).toEqual([
			{
				kind: 'send',
				op: ServerOp.CHAT,
				payload: { senderId: 'a', displayName: 'A', message: 'hello' },
				to: ['a', 'b'],
			},
		])
	})
	it('keeps lines as moderation context, marking who sent each', () => {
		let lobby = chatPost(lobbyOf('a', 'b'), 'a', 'one').lobby
		lobby = chatPost(lobby, 'b', 'two').lobby
		const check = chatCheck(lobby, 'a', 0)
		expect(check.ok && check.context).toEqual([
			{ who: 'sender', text: 'one' },
			{ who: 'other', text: 'two' },
		])
	})
	it('drops a line from someone who has left', () => {
		expect(chatPost(lobbyOf('a'), 'x', 'hi').out).toEqual([])
	})
})
