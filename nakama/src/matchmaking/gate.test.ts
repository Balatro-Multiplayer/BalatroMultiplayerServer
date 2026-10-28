import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, writeConfig } from '../config'
import { writeBans } from '../moderation/bans'
import { NotifyCode } from '../notify'
import { fakeLogger, fakeNk, playerCtx, settingsFor } from '../testing/fake_nk'
import { reportVanilla } from '../testing/reports'
import { verdictRecord, writeIntegrity } from '../integrity'
import { writeModReport } from '../standing/storage'
import { beforeMatchmakerAdd, queueRefusalFor, refuseMatchedGroup } from './gate'

const PINNED = { ...DEFAULT_CONFIG, queueAllowedModIds: ['MultiplayerAPI'] }
const report = (nk: any, userId: string, mods: string[]) => writeModReport(nk, userId, { mods, reportedAt: 0 })

const ADD = (kind: string) => ({ matchmakerAdd: { query: `+properties.modId:M +properties.mode:standard +properties.kind:${kind}`, stringProperties: { modId: 'M', mode: 'standard', kind } } })

describe('beforeMatchmakerAdd', () => {
	it('lets tickets through, and refuses queue-banned players and switched-off queues', () => {
		const nk = fakeNk()
		reportVanilla(nk, 'u1', 'u2')
		const envelope = ADD('casual')
		expect(beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, envelope)).toBe(envelope)
		writeBans(nk as any, 'u1', { queue: { banId: 'q', expiresAt: null, reason: '' } })
		expect(() => beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, envelope)).toThrow(/banned/)
		writeConfig(nk as any, { ...DEFAULT_CONFIG, rankedEnabled: false })
		expect(() => beforeMatchmakerAdd(playerCtx('u2'), fakeLogger, nk as any, ADD('ranked'))).toThrow(/Ranked/)
		expect(beforeMatchmakerAdd(playerCtx('u2'), fakeLogger, nk as any, ADD('casual'))).toBeTruthy()
	})
	it.each(['community', 'dev'])('lets a player with any mod queue on a %s server', (kind) => {
		const nk = fakeNk()
		report(nk, 'u1', ['MultiplayerDev-0.1.0', 'Talisman-2.0'])
		const envelope = ADD('casual')
		expect(beforeMatchmakerAdd(playerCtx('u1', { BMP_SERVER_KIND: kind }), fakeLogger, nk as any, envelope)).toBe(envelope)
		expect(() => beforeMatchmakerAdd(playerCtx('u1', { BMP_SERVER_KIND: 'official' }), fakeLogger, nk as any, envelope)).toThrow(/Talisman/)
	})
	it("refuses a ticket whose query reaches past its own mod's queue", () => {
		const nk = fakeNk()
		reportVanilla(nk, 'u1')
		const wide = { matchmakerAdd: { query: '*', stringProperties: { modId: 'M', mode: 'standard', kind: 'casual' } } }
		expect(() => beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, wide)).toThrow('The ticket does not match its queue')
		const nameless = { matchmakerAdd: { query: '+properties.modId:M', stringProperties: {} } }
		expect(() => beforeMatchmakerAdd(playerCtx('u1'), fakeLogger, nk as any, nameless)).toThrow('The ticket does not name a queue')
	})
})

const plan = (playerIds: string[], rankedMode = '') => ({
	modId: 'M',
	rankedMode,
	gameMode: rankedMode ? 'ranked:' + rankedMode : 'casual-mode',
	playerIds,
	groups: [],
	teamPlan: null,
	requiredStanding: 'valid' as const,
})

describe('refuseMatchedGroup', () => {
	it('passes a group that may all queue', () => {
		const nk = fakeNk()
		reportVanilla(nk, 'a', 'b')
		expect(refuseMatchedGroup(nk as any, settingsFor(), fakeLogger, plan(['a', 'b']))).toBe(false)
	})
	it('refuses a group with a banned player and tells the others', () => {
		const nk = fakeNk()
		reportVanilla(nk, 'a', 'b', 'c')
		writeBans(nk as any, 'b', { queue: { banId: 'q', expiresAt: null, reason: '' } })
		expect(refuseMatchedGroup(nk as any, settingsFor(), fakeLogger, plan(['a', 'b', 'c'], 'std'))).toBe(true)
		expect(nk.notifications.map((n) => [n.userId, n.code])).toEqual([
			['a', NotifyCode.QUEUE_CANCELLED],
			['c', NotifyCode.QUEUE_CANCELLED],
		])
		expect(nk.notifications[0].content).toMatchObject({ modId: 'M', mode: 'std', requeue: true })
	})
})

describe('the standing gate', () => {
	it('is always on: an unreported or non-allowed player is refused before any API push', () => {
		const nk = fakeNk()
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toEqual({ code: 'mods_unreported' })
		report(nk, 'u', ['Talisman-2.0'])
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toEqual({ code: 'mods_not_allowed', mods: ['Talisman'] })
		report(nk, 'u', ['Steamodded-1.0.0~BETA-1814a', 'Lovely-0.9.0'])
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toBeNull()
	})
	it('refuses casual without a report, or with a mod that is not allowed, naming it', () => {
		const nk = fakeNk()
		writeConfig(nk as any, PINNED)
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toEqual({ code: 'mods_unreported' })
		report(nk, 'u', ['Steamodded-1.0.0~BETA-1814a', 'Lovely-0.9.0', 'MultiplayerAPI-0.1.2', 'Talisman-2.0'])
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toEqual({ code: 'mods_not_allowed', mods: ['Talisman'] })
		expect(() => beforeMatchmakerAdd(playerCtx('u'), fakeLogger, nk as any, ADD('casual'))).toThrow(
			"These mods aren't allowed in matchmaking: Talisman. Private lobbies allow any mods.",
		)
		writeConfig(nk as any, { ...PINNED, queueAllowedModIdsExtra: ['Talisman'] })
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toBeNull()
	})
	it('names the one blocked mod by SMODS id, and says private lobbies allow any mods', () => {
		const nk = fakeNk()
		writeConfig(nk as any, PINNED)
		report(nk, 'u', ['MultiplayerAPI-0.1.2', 'Talisman-2.0'])
		expect(() => beforeMatchmakerAdd(playerCtx('u'), fakeLogger, nk as any, ADD('casual'))).toThrow(
			"These mods aren't allowed in matchmaking: Talisman. Private lobbies allow any mods.",
		)
	})
	it('names every blocked mod by SMODS id, however many', () => {
		const nk = fakeNk()
		writeConfig(nk as any, PINNED)
		report(nk, 'u', ['MultiplayerAPI-0.1.2', 'Talisman-2.0', 'Cryptid-0.5.3', 'Jen-1.0', 'Ortalab-1.0', 'Bunco-5.0'])
		expect(() => beforeMatchmakerAdd(playerCtx('u'), fakeLogger, nk as any, ADD('casual'))).toThrow(
			"These mods aren't allowed in matchmaking: Talisman, Cryptid, Jen, Ortalab, Bunco. Private lobbies allow any mods.",
		)
	})
	it('keeps ranked behind the launcher, and a verdict skips the mod check', () => {
		const nk = fakeNk()
		writeConfig(nk as any, { ...PINNED, integrityEnforced: true })
		report(nk, 'u', ['MultiplayerAPI-0.1.2'])
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toBeNull()
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', true, 0)).toEqual({ code: 'integrity_required' })
		report(nk, 'u', ['Talisman-2.0'])
		writeIntegrity(nk as any, 'u', verdictRecord(true, true, 0))
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', true, 0)).toBeNull()
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', false, 0)).toBeNull()
	})
	it('applies the mod check to ranked while integrity is not enforced', () => {
		const nk = fakeNk()
		writeConfig(nk as any, PINNED)
		report(nk, 'u', ['Talisman-2.0'])
		expect(queueRefusalFor(nk as any, settingsFor(), 'u', true, 0)).toEqual({ code: 'mods_not_allowed', mods: ['Talisman'] })
	})
	it('tells a matched solo refused over their mods why, and requeues the rest', () => {
		const nk = fakeNk()
		writeConfig(nk as any, PINNED)
		report(nk, 'a', ['MultiplayerAPI-0.1.2'])
		report(nk, 'b', ['Talisman-2.0'])
		expect(refuseMatchedGroup(nk as any, settingsFor(), fakeLogger, plan(['a', 'b']))).toBe(true)
		expect(nk.notifications.map((n) => [n.userId, n.content.requeue, n.content.code])).toEqual([
			['a', true, undefined],
			['b', false, 'mods_not_allowed'],
		])
		expect(nk.notifications[1].content).toMatchObject({
			mode: 'casual-mode',
			mods: ['Talisman'],
			reason: "These mods aren't allowed in matchmaking: Talisman. Private lobbies allow any mods.",
		})
	})
})
