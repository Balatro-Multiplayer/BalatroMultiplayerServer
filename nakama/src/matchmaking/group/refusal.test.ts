import { describe, expect, it } from 'vitest'
import type { GroupQueueView } from '../../lobby/protocol'
import {
	MAX_GROUP_SIZE,
	countRefusal,
	homeRefusal,
	isPartyId,
	joinRefusal,
	memberRefusal,
	partyRefusal,
	refusalMessage,
	requestRefusal,
	ticketRefusal,
	type GroupHomeFacts,
	type PartyTicket,
	type TicketFacts,
} from './refusal'

const PARTY = '0b0c4a9e-7f43-4f43-9f6e-1d2c3b4a5f60.bmp-local'
const home = (over: Partial<GroupHomeFacts> = {}): GroupHomeFacts => ({
	code: 'HOME12',
	modId: 'M',
	hostId: 'a',
	isPrivate: true,
	ranked: false,
	started: false,
	closed: false,
	members: [
		{ id: 'a', present: true },
		{ id: 'b', present: true },
	],
	groupQueue: null,
	...over,
})
const status = (over: Partial<GroupQueueView> = {}): GroupQueueView => ({
	phase: 'forming',
	partyId: PARTY,
	homeCode: 'HOME12',
	modId: 'M',
	mode: 'std',
	teams: false,
	hostId: 'a',
	memberIds: ['a', 'b'],
	ticket: null,
	matchId: null,
	code: null,
	...over,
})
const ticket = (over: Partial<PartyTicket> = {}): PartyTicket => ({
	minCount: 3,
	maxCount: 4,
	countMultiple: null,
	stringProperties: { modId: 'M', mode: 'std', kind: 'casual' },
	numericProperties: { groupSize: 2 },
	query: '+properties.modId:M +properties.mode:std +properties.kind:casual',
	...over,
})
const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({
	switches: { groupQueueEnabled: true },
	status: status(),
	leaderId: 'a',
	partyUserIds: ['b', 'a'],
	members: { refusals: {}, queuedIds: [] },
	ticket: ticket(),
	...over,
})
const code = (r: { code: string } | null) => (r ? r.code : null)

describe('requestRefusal', () => {
	it('takes a casual request naming a party and a mode', () => {
		expect(requestRefusal({ partyId: PARTY, mode: 'std', teams: false, ranked: false })).toBeNull()
		expect(code(requestRefusal({ partyId: PARTY, mode: 'std', teams: false, ranked: true }))).toBe('ranked')
		expect(code(requestRefusal({ partyId: 'nope', mode: 'std', teams: false, ranked: false }))).toBe('bad_request')
		expect(code(requestRefusal({ partyId: PARTY, mode: 'a b', teams: false, ranked: false }))).toBe('bad_request')
		expect(isPartyId(PARTY.toUpperCase())).toBe(false)
	})
})

describe('homeRefusal', () => {
	const on = { groupQueueEnabled: true }
	it('lets the host of an idle private lobby with everyone connected queue', () => {
		expect(homeRefusal(home(), 'a', on)).toBeNull()
	})
	it('names what is wrong', () => {
		expect(code(homeRefusal(home(), 'a', { groupQueueEnabled: false }))).toBe('disabled')
		expect(code(homeRefusal(home(), 'z', on))).toBe('not_in_lobby')
		expect(code(homeRefusal(home({ closed: true }), 'a', on))).toBe('not_in_lobby')
		expect(code(homeRefusal(home(), 'b', on))).toBe('not_host')
		expect(code(homeRefusal(home({ isPrivate: false }), 'a', on))).toBe('not_private')
		expect(code(homeRefusal(home({ ranked: true }), 'a', on))).toBe('ranked')
		expect(code(homeRefusal(home({ started: true }), 'a', on))).toBe('in_game')
		expect(code(homeRefusal(home({ groupQueue: status() }), 'a', on))).toBe('already_queued')
		expect(code(homeRefusal(home({ members: [{ id: 'a', present: true }] }), 'a', on))).toBe('too_few')
		const crowd = Array.from({ length: MAX_GROUP_SIZE + 1 }, (_, i) => ({ id: i ? 'p' + i : 'a', present: true }))
		expect(code(homeRefusal(home({ members: crowd }), 'a', on))).toBe('too_many')
		const away = homeRefusal(home({ members: [{ id: 'a', present: true }, { id: 'b', present: false }] }), 'a', on)
		expect(away).toEqual({ code: 'member_away', userId: 'b' })
	})
})

describe('memberRefusal / partyRefusal / joinRefusal', () => {
	it('refuses a member who may not queue, with their reason, then one already queued', () => {
		const banned = { code: 'access_denied' as const, message: 'Banned.' }
		const refused = memberRefusal(['a', 'b'], { refusals: { b: banned }, queuedIds: ['a'] })
		expect(refused).toEqual({ code: 'member_refused', userId: 'b', detail: 'Banned.', reason: 'access_denied', mods: [] })
		expect(refusalMessage(refused!)).toBe('A player in the lobby may not queue. Banned.')
		expect(memberRefusal(['a', 'b'], { refusals: {}, queuedIds: ['a'] })).toEqual({ code: 'member_queued', userId: 'a' })
		expect(memberRefusal(['a', 'b'], { refusals: {}, queuedIds: ['z'] })).toBeNull()
	})
	it("names a member's disallowed mods", () => {
		const mods = { code: 'mods_not_allowed' as const, mods: ['ClaudeControl', 'Talisman'] }
		expect(memberRefusal(['a'], { refusals: { a: mods }, queuedIds: [] })).toEqual({
			code: 'member_refused',
			userId: 'a',
			detail: "These mods aren't allowed in matchmaking: ClaudeControl, Talisman",
			reason: 'mods_not_allowed',
			mods: ['ClaudeControl', 'Talisman'],
		})
		const unreported = memberRefusal(['a'], { refusals: { a: { code: 'mods_unreported' } }, queuedIds: [] })
		expect(unreported).toMatchObject({ code: 'member_refused', reason: 'mods_unreported', mods: [] })
	})
	it('wants the host in the party and no strangers', () => {
		expect(partyRefusal(['a'], ['a', 'b'], 'a')).toBeNull()
		expect(partyRefusal(['b'], ['a', 'b'], 'a')).toEqual({ code: 'party_mismatch', userId: 'a' })
		expect(partyRefusal(['a', 'z'], ['a', 'b'], 'a')).toEqual({ code: 'party_mismatch', userId: 'z' })
	})
	it('lets only members join the party, only while forming', () => {
		expect(joinRefusal(status(), 'b')).toBeNull()
		expect(code(joinRefusal(status(), 'z'))).toBe('not_member')
		expect(code(joinRefusal(status({ phase: 'queued' }), 'b'))).toBe('not_forming')
	})
})

describe('countRefusal', () => {
	it('never lets a group match only itself', () => {
		expect(countRefusal(2, false, ticket())).toBeNull()
		expect(code(countRefusal(2, false, ticket({ minCount: 2 })))).toBe('bad_counts')
		expect(code(countRefusal(2, false, ticket({ maxCount: 2 })))).toBe('bad_counts')
		expect(code(countRefusal(2, false, ticket({ countMultiple: 2 })))).toBe('bad_counts')
	})
	it('wants whole teams for Teams', () => {
		expect(countRefusal(2, true, ticket({ minCount: 4, maxCount: 4, countMultiple: 2 }))).toBeNull()
		expect(code(countRefusal(2, true, ticket({ minCount: 3, maxCount: 4, countMultiple: 2 })))).toBe('bad_counts')
		expect(code(countRefusal(2, true, ticket({ minCount: 4, maxCount: 4 })))).toBe('bad_counts')
	})
})

describe('ticketRefusal', () => {
	it('takes the host’s ticket for the forming group', () => {
		expect(ticketRefusal(facts())).toBeNull()
	})
	it('names what is wrong', () => {
		expect(code(ticketRefusal(facts({ status: null })))).toBe('not_bound')
		expect(code(ticketRefusal(facts({ switches: { groupQueueEnabled: false } })))).toBe('disabled')
		expect(code(ticketRefusal(facts({ status: status({ phase: 'queued' }) })))).toBe('not_forming')
		expect(code(ticketRefusal(facts({ leaderId: 'b' })))).toBe('not_leader')
		expect(code(ticketRefusal(facts({ partyUserIds: ['a'] })))).toBe('party_mismatch')
		expect(code(ticketRefusal(facts({ partyUserIds: ['a', 'b', 'z'] })))).toBe('party_mismatch')
		const props = (s: { [k: string]: unknown }, n: { [k: string]: unknown } = { groupSize: 2 }) =>
			code(ticketRefusal(facts({ ticket: ticket({ stringProperties: { modId: 'M', mode: 'std', ...s }, numericProperties: n }) })))
		expect(props({ kind: 'ranked' })).toBe('ranked')
		expect(props({ mode: 'other' })).toBe('ticket_mismatch')
		expect(props({ modId: 'X' })).toBe('ticket_mismatch')
		expect(props({}, { groupSize: 3 })).toBe('ticket_mismatch')
		expect(props({}, {})).toBe('ticket_mismatch')
		expect(props({}, { groupSize: 2, teams: 1 })).toBe('ticket_mismatch')
		expect(code(ticketRefusal(facts({ ticket: ticket({ query: '*' }) })))).toBe('ticket_mismatch')
		expect(code(ticketRefusal(facts({ ticket: ticket({ query: '+properties.modId:X +properties.mode:std' }) })))).toBe('ticket_mismatch')
		expect(code(ticketRefusal(facts({ ticket: ticket({ minCount: 2 }) })))).toBe('bad_counts')
		expect(code(ticketRefusal(facts({ members: { refusals: { b: { code: 'mods_unreported' } }, queuedIds: [] } })))).toBe('member_refused')
	})
	it('a Teams group ticket says so and asks for whole teams', () => {
		const teams = facts({
			status: status({ teams: true }),
			ticket: ticket({ minCount: 4, maxCount: 4, countMultiple: 2, numericProperties: { groupSize: 2, teams: 1 } }),
		})
		expect(ticketRefusal(teams)).toBeNull()
	})
})
