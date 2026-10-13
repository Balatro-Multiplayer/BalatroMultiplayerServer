import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { writeBans } from '../moderation/bans'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { beforeMatchmakerAdd, refuseMatchedGroup } from './gate'

const ADD = (kind: string) => ({ matchmakerAdd: { stringProperties: { modId: 'M', mode: 'standard', kind } } })

describe('beforeMatchmakerAdd', () => {
	it('lets tickets through, and refuses queue-banned players and switched-off queues', () => {
		const nk = fakeNk()
		const envelope = ADD('casual')
		expect(beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, envelope)).toBe(envelope)
		writeBans(nk as any, 'u1', { queue: { banId: 'q', expiresAt: null, reason: '' } })
		expect(() => beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, envelope)).toThrow(/banned/)
		writeConfig(nk as any, { ...DEFAULT_CONFIG, rankedEnabled: false })
		expect(() => beforeMatchmakerAdd(playerCtx('u2'), fakeLogger, nk as any, ADD('ranked'))).toThrow(/Ranked/)
		expect(beforeMatchmakerAdd(playerCtx('u2'), fakeLogger, nk as any, ADD('casual'))).toBeTruthy()
	})
})

const plan = (playerIds: string[], rankedMode = '') => ({
	modId: 'M',
	rankedMode,
	gameMode: rankedMode ? 'ranked:' + rankedMode : 'casual-mode',
	playerIds,
})

describe('refuseMatchedGroup', () => {
	it('passes a group that may all queue', () => {
		expect(refuseMatchedGroup(fakeNk() as any, fakeLogger, plan(['a', 'b']))).toBe(false)
	})
	it('refuses a group with a banned player and tells the others', () => {
		const nk = fakeNk()
		writeBans(nk as any, 'b', { queue: { banId: 'q', expiresAt: null, reason: '' } })
		expect(refuseMatchedGroup(nk as any, fakeLogger, plan(['a', 'b', 'c'], 'std'))).toBe(true)
		expect(nk.notifications.map((n) => [n.userId, n.code])).toEqual([
			['a', NotifyCode.QUEUE_CANCELLED],
			['c', NotifyCode.QUEUE_CANCELLED],
		])
		expect(nk.notifications[0].content).toMatchObject({ modId: 'M', mode: 'std', requeue: true })
	})
})
