import { describe, expect, it } from 'vitest'
import { NOTICE_VERSION } from '../../../packages/types/src/notice'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { defaultProfile, writeProfile, type Profile } from '../player/profile'
import { CURRENT_LOBBY_COLLECTION, CURRENT_LOBBY_KEY } from '../lobby/protocol'
import { MIRROR_COLLECTION } from '../mirror/outbox'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { rpcChatEnable, rpcChatSend } from './rpc'

const USER = '11111111-1111-4111-8111-111111111111'

function nkWith(profile: Partial<Profile>, config = {}) {
	const nk = fakeNk()
	writeConfig(nk as any, { ...DEFAULT_CONFIG, ...config })
	writeProfile(nk as any, USER, { ...defaultProfile('Alice'), ...profile })
	return nk
}

const enable = (nk: unknown) => JSON.parse(rpcChatEnable(playerCtx(USER), fakeLogger, nk as any, '{}'))
const send = (nk: unknown) => rpcChatSend(playerCtx(USER), fakeLogger, nk as any, JSON.stringify({ message: 'hi' }))

describe('chat_enable', () => {
	it('turns chat on once the current Notice is accepted', () => {
		const nk = nkWith({ tosAcceptedVersion: NOTICE_VERSION })
		expect(enable(nk).player.chatEnabled).toBe(true)
	})

	it('waits for the current Notice', () => {
		expect(() => enable(nkWith({ tosAcceptedVersion: NOTICE_VERSION - 1 }))).toThrow(/Accept the Notice/)
	})

	it('refuses a chat-blocked account', () => {
		expect(() => enable(nkWith({ tosAcceptedVersion: NOTICE_VERSION, chatBlocked: true }))).toThrow(/restricted/)
	})
})

describe('chat_send gates', () => {
	it('refuses when chat is off server-wide', () => {
		const nk = nkWith({ tosAcceptedVersion: NOTICE_VERSION, chatEnabled: true }, { chatEnabled: false })
		expect(() => send(nk)).toThrow(/turned off/)
	})

	it('refuses players without chat enabled', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: NOTICE_VERSION }))).toThrow(/not enabled/)
		expect(() => send(nkWith({ tosAcceptedVersion: NOTICE_VERSION, chatEnabled: true, chatBlocked: true }))).toThrow(/not enabled/)
	})

	it('refuses after a ToS update until it is accepted', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: NOTICE_VERSION - 1, chatEnabled: true }))).toThrow(/Accept the Notice/)
	})

	it('lets an enabled player through to the lobby check', () => {
		expect(() => send(nkWith({ tosAcceptedVersion: NOTICE_VERSION, chatEnabled: true }))).toThrow(/Not in a lobby/)
	})
})

// Seated in lobby ABCDEF; the moderation service answers with verdict.
function seated(verdict: unknown, config = {}) {
	const nk = nkWith({ tosAcceptedVersion: NOTICE_VERSION, chatEnabled: true }, config)
	let next = 0
	nk.uuidv4 = () => `u${++next}`
	nk.matchGet = () => ({})
	nk.posted = [] as string[]
	nk.matchSignal = (_id: string, data: string) => {
		const signal = JSON.parse(data)
		if (signal.type === 'has_player') return 'yes'
		if (signal.type === 'chat_check') return JSON.stringify({ code: 'ABCDEF', context: [] })
		if (signal.type === 'chat_post') nk.posted.push(signal.text)
		return 'ok'
	}
	nk.httpRequest = (url: string, method: string, headers: any, body: string) => {
		nk.http.push({ url, method, headers, body })
		return { code: 200, headers: {}, body: JSON.stringify(verdict) }
	}
	nk.storageWrite([{ collection: CURRENT_LOBBY_COLLECTION, key: CURRENT_LOBBY_KEY, userId: USER, value: { matchId: 'm1', code: 'ABCDEF', modId: 'M' } }])
	return nk
}

const say = (nk: unknown, message: string, env = {}) =>
	JSON.parse(rpcChatSend(playerCtx(USER, env), fakeLogger, nk as any, JSON.stringify({ message })))
const logged = (nk: any) =>
	[...nk.objects.entries()].filter(([k]: [string]) => k.startsWith(MIRROR_COLLECTION + '/')).map(([, o]: any) => o.value.line)

describe('chat_send moderation', () => {
	it('posts an allowed message and logs what was typed', () => {
		const nk = seated({ verdict: 'allow', publishText: 'h*llo' })
		expect(say(nk, 'hello')).toEqual({ text: 'h*llo' })
		expect(nk.posted).toEqual(['h*llo'])
		expect(logged(nk)).toEqual([{ lobbyCode: 'ABCDEF', lobbyId: 'm1', lobbyKind: null, userId: USER, message: 'hello', flagged: false, verdict: null }])
	})

	it('logs a blocked message with its band, and posts nothing', () => {
		const nk = seated({ verdict: 'reject', band: 'high' })
		expect(() => say(nk, 'bad words')).toThrow(/blocked/)
		expect(nk.posted).toEqual([])
		expect(logged(nk)).toEqual([
			{ lobbyCode: 'ABCDEF', lobbyId: 'm1', lobbyKind: null, userId: USER, message: 'bad words', flagged: true, verdict: { source: 'remote', band: 'high' } },
		])
	})

	it('logs nothing it could not judge', () => {
		const nk = seated({ verdict: 'reject', band: 'guard_unavailable' })
		expect(() => say(nk, 'hello')).toThrow(/unavailable/)
		expect(logged(nk)).toEqual([])
	})

	it('skips the service for an allowlisted message', () => {
		const nk = seated({ verdict: 'reject', band: 'high' }, { chatAllowlist: ['good game'] })
		expect(say(nk, 'Good game!')).toEqual({ text: 'Good game!' })
		expect(nk.http).toEqual([])
	})

	it('falls back to the word filter with the service switched off', () => {
		const nk = seated({ verdict: 'reject', band: 'high' })
		const off = { MODERATION_REMOTE: 'off' }
		expect(say(nk, 'nice hand', off)).toEqual({ text: 'nice hand' })
		expect(() => say(nk, 'what the fuck', off)).toThrow(/blocked/)
		expect(nk.http).toEqual([])
		const [, blocked] = logged(nk)
		expect(blocked.verdict).toEqual({ source: 'local', matches: [{ word: 'fuck', startIndex: 9, endIndex: 12 }] })
	})

	it('works on a Community server without the moderation service', () => {
		const nk = seated({ verdict: 'reject', band: 'guard_unavailable' })
		const community = { BMP_SERVER_KIND: 'community' }
		expect(say(nk, 'nice hand', community)).toEqual({ text: 'nice hand' })
		expect(() => say(nk, 'what the fuck', community)).toThrow(/blocked/)
		expect(nk.http).toEqual([])
	})
})
