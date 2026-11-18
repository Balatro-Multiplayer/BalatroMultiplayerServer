import { describe, expect, it } from 'vitest'
import { ANNOUNCEMENT_MAX_LENGTH, rpcAdminAnnounce } from './announcement'
import { NotifyCode, isNotifyCode } from './notify'
import { fakeLogger, fakeNk, playerCtx, serverCtx } from './testing/fake_nk'

const call = (nk: any, body: object, ctx = serverCtx()) =>
	JSON.parse(rpcAdminAnnounce(ctx, fakeLogger, nk, JSON.stringify(body)))

describe('admin_announce', () => {
	it('sends the text to every online session as one transient notification', () => {
		const nk = fakeNk()
		expect(call(nk, { text: '  Ranked is closed.  ' })).toEqual({ ok: true })
		expect(nk.broadcasts).toEqual([
			{ subject: 'announcement', content: { text: 'Ranked is closed.' }, code: NotifyCode.ANNOUNCEMENT, persistent: false },
		])
		expect(nk.notifications).toEqual([])
	})

	it('uses a new code the notify list knows', () => {
		expect(NotifyCode.ANNOUNCEMENT).toBe(113)
		expect(isNotifyCode(113)).toBe(true)
	})

	it('refuses a player session, a blank text, a non-string and a text over the limit', () => {
		const nk = fakeNk()
		expect(() => call(nk, { text: 'hi' }, playerCtx('11111111-1111-1111-1111-111111111111'))).toThrow()
		expect(() => call(nk, { text: '   ' })).toThrow()
		expect(() => call(nk, { text: 5 })).toThrow()
		expect(() => call(nk, {})).toThrow()
		expect(() => call(nk, { text: 'x'.repeat(ANNOUNCEMENT_MAX_LENGTH + 1) })).toThrow()
		expect(nk.broadcasts).toEqual([])
		expect(call(nk, { text: 'x'.repeat(ANNOUNCEMENT_MAX_LENGTH) })).toEqual({ ok: true })
	})
})
