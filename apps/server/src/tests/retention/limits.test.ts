import { describe, expect, it } from 'vitest'
import {
	banRecordPurgeable,
	evidencePurgeable,
	linkOfBan,
	linkOfItem,
} from '../../features/retention/limits.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-26T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY)

describe('evidencePurgeable', () => {
	it('keeps evidence with no report or ban for 180 days from when it was made', () => {
		expect(evidencePurgeable({ madeAt: daysAgo(179), links: [] }, NOW)).toBe(
			false,
		)
		expect(evidencePurgeable({ madeAt: daysAgo(181), links: [] }, NOW)).toBe(
			true,
		)
	})

	it('keeps evidence while a report or ban that uses it is open, however old', () => {
		const links = [{ closedAt: daysAgo(400) }, { closedAt: null }]
		expect(evidencePurgeable({ madeAt: daysAgo(1000), links }, NOW)).toBe(false)
	})

	it('keeps evidence 180 days after the last report or ban that used it closed', () => {
		const madeAt = daysAgo(500)
		expect(
			evidencePurgeable(
				{
					madeAt,
					links: [{ closedAt: daysAgo(300) }, { closedAt: daysAgo(10) }],
				},
				NOW,
			),
		).toBe(false)
		expect(
			evidencePurgeable(
				{
					madeAt,
					links: [{ closedAt: daysAgo(300) }, { closedAt: daysAgo(181) }],
				},
				NOW,
			),
		).toBe(true)
	})
})

describe('linkOfItem', () => {
	it('is open while the queue item is open, else closed when it was resolved', () => {
		expect(linkOfItem({ status: 'open', resolvedAt: null })).toEqual({
			closedAt: null,
		})
		expect(linkOfItem({ status: 'resolved', resolvedAt: daysAgo(3) })).toEqual({
			closedAt: daysAgo(3),
		})
	})
})

describe('linkOfBan', () => {
	it('is open while the ban is in force', () => {
		expect(linkOfBan({ expiresAt: null, liftedAt: null }, NOW)).toEqual({
			closedAt: null,
		})
		expect(linkOfBan({ expiresAt: daysAgo(-5), liftedAt: null }, NOW)).toEqual({
			closedAt: null,
		})
	})

	it('closes when it ran out or was lifted, whichever came first', () => {
		expect(linkOfBan({ expiresAt: daysAgo(20), liftedAt: null }, NOW)).toEqual({
			closedAt: daysAgo(20),
		})
		expect(linkOfBan({ expiresAt: null, liftedAt: daysAgo(7) }, NOW)).toEqual({
			closedAt: daysAgo(7),
		})
		expect(
			linkOfBan({ expiresAt: daysAgo(-30), liftedAt: daysAgo(7) }, NOW),
		).toEqual({ closedAt: daysAgo(7) })
	})
})

describe('banRecordPurgeable', () => {
	it('keeps a permanent ban record', () => {
		expect(banRecordPurgeable({ expiresAt: null }, NOW)).toBe(false)
	})

	it('keeps a timed ban record for the ban length plus 12 months', () => {
		// Ran out 2025-10-27: kept until 2026-10-27.
		expect(
			banRecordPurgeable({ expiresAt: new Date('2025-10-27T12:00:00Z') }, NOW),
		).toBe(false)
		// Ran out 2025-10-25: its 12 months ended 2026-10-25.
		expect(
			banRecordPurgeable({ expiresAt: new Date('2025-10-25T12:00:00Z') }, NOW),
		).toBe(true)
		// Still in force.
		expect(banRecordPurgeable({ expiresAt: daysAgo(-3) }, NOW)).toBe(false)
	})
})
