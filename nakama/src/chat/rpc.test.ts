import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { defaultProfile, writeProfile, type Profile } from '../player/profile'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { rpcChatEnable, rpcChatSend } from './rpc'

const USER = '11111111-1111-4111-8111-111111111111'

function nkWith(profile: Partial<Profile>, config = {}) {
	const nk = fakeNk()
	writeConfig(nk as any, { ...DEFAULT_CONFIG, tosVersion: 2, ...config })
	writeProfile(nk as any, USER, { ...defaultProfile('Alice'), ...profile })
	return nk
}

const enable = (nk: unknown) => JSON.parse(rpcChatEnable(playerCtx(USER), fakeLogger, nk as any, '{}'))
const send = (nk: unknown) => rpcChatSend(playerCtx(USER), fakeLogger, nk as any, JSON.stringify({ message: 'hi' }))

describe('chat_enable', () => {
	it('turns chat on once the current ToS is accepted', () => {
		const nk = nkWith({ tosAcceptedVersion: 2 })
		expect(enable(nk).player.chatEnabled).toBe(true)
	})

	it('waits for the current ToS', () => {
		expect(() => enable(nkWith({ tosAcceptedVersion: 1 }))).toThrow(/Terms of Service/)
	})

	it('refuses a chat-blocked account', () => {
		expect(() => enable(nkWith({ tosAcceptedVersion: 2, chatBlocked: true }))).toThrow(/restricted/)
	})
})

describe('chat_send gates', () => {
	it('refuses when chat is off server-wide', () => {
		const nk = nkWith({ tosAcceptedVersion: 2, chatEnabled: true }, { chatEnabled: false })
		expect(() => send(nk)).toThrow(/turned off/)
	})

	it('refuses players without chat enabled', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: 2 }))).toThrow(/not enabled/)
		expect(() => send(nkWith({ tosAcceptedVersion: 2, chatEnabled: true, chatBlocked: true }))).toThrow(/not enabled/)
	})

	it('refuses after a ToS update until it is accepted', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: 1, chatEnabled: true }))).toThrow(/Terms of Service/)
	})

	it('lets an enabled player through to the lobby check', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: 2, chatEnabled: true }))).toThrow(/Not in a lobby/)
	})
})
