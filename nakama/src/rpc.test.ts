import { describe, expect, it } from 'vitest'
import { parsePayload, requireServer, requireUser } from './rpc'
import { playerCtx, serverCtx } from './testing/fake_nk'

describe('rpc helpers', () => {
	it('requireUser returns the caller and refuses a server call', () => {
		expect(requireUser(playerCtx('u1'))).toBe('u1')
		expect(() => requireUser(serverCtx())).toThrow()
	})

	it('requireServer refuses any player session', () => {
		expect(() => requireServer(serverCtx())).not.toThrow()
		expect(() => requireServer(playerCtx('u1'))).toThrow()
	})

	it('parsePayload reads objects, treats empty and [] as {}, and rejects the rest', () => {
		expect(parsePayload('')).toEqual({})
		expect(parsePayload('[]')).toEqual({})
		expect(parsePayload('{"a":1}')).toEqual({ a: 1 })
		expect(() => parsePayload('[1]')).toThrow()
		expect(() => parsePayload('"x"')).toThrow()
		expect(() => parsePayload('{bad')).toThrow()
	})
})
