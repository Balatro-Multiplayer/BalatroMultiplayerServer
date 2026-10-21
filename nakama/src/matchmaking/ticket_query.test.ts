import { describe, expect, it } from 'vitest'
import { ticketQueryRefusal } from './ticket_query'

const PROPS = { modId: 'MultiplayerSPDRN', mode: 'standard', kind: 'casual' }
const HONEST = '+properties.modId:MultiplayerSPDRN +properties.mode:standard +properties.kind:casual'

describe('ticketQueryRefusal', () => {
	it("passes the client's casual, ranked and Teams tickets", () => {
		expect(ticketQueryRefusal(HONEST, PROPS)).toBeNull()
		expect(
			ticketQueryRefusal(
				'+properties.modId:MultiplayerSPDRN +properties.mode:standard +properties.kind:ranked +properties.rating:>=850 +properties.rating:<=1150',
				{ ...PROPS, kind: 'ranked' },
			),
		).toBeNull()
		expect(ticketQueryRefusal(HONEST + ' +properties.teams:>=1', PROPS)).toBeNull()
	})

	it('passes a ticket without a kind clause or kind property', () => {
		expect(ticketQueryRefusal('+properties.modId:M +properties.mode:x.y-z', { modId: 'M', mode: 'x.y-z' })).toBeNull()
	})

	it("refuses a query that doesn't pin its own mod and mode", () => {
		expect(ticketQueryRefusal('*', PROPS)).toBe('query_not_pinned')
		expect(ticketQueryRefusal('+properties.modId:MultiplayerPvP +properties.mode:standard', PROPS)).toBe('query_not_pinned')
		expect(ticketQueryRefusal('properties.modId:MultiplayerSPDRN +properties.mode:standard', PROPS)).toBe('query_not_pinned')
		expect(ticketQueryRefusal('+properties.modId:MultiplayerSPDRN^0 +properties.mode:standard', PROPS)).toBe('query_not_pinned')
		expect(ticketQueryRefusal('+properties.modId:MultiplayerSPDRN', PROPS)).toBe('query_not_pinned')
		expect(ticketQueryRefusal(undefined, PROPS)).toBe('query_not_pinned')
	})

	it('refuses properties that name no queue', () => {
		expect(ticketQueryRefusal(HONEST, {})).toBe('bad_properties')
		expect(ticketQueryRefusal(HONEST, { ...PROPS, modId: 'a b' })).toBe('bad_properties')
		expect(ticketQueryRefusal(HONEST, { ...PROPS, mode: 7 })).toBe('bad_properties')
		expect(ticketQueryRefusal(HONEST, { ...PROPS, kind: 'tournament' })).toBe('bad_properties')
	})
})
