import { describe, expect, it } from 'vitest'
import {
	parseLegacyGameRecord,
	toInsert,
} from '../../features/legacy-games/import-records.js'
import { compressToBase64 } from '../../shared/utils/compression.js'

const events = compressToBase64(JSON.stringify([[0, 'end', { result: 'win' }]]))

const record = {
	id: 12,
	ownerDiscordId: '123456789012345678',
	ownerName: 'Old Name',
	opponentName: 'Rival',
	startedAt: '2025-06-21T19:20:44.000Z',
	endedAt: '2025-06-21T19:41:02.000Z',
	timeExact: false,
	result: 'win',
	deck: 'Red Deck',
	stake: null,
	seed: 'ABCD1234',
	beta: { season: 4, matchKey: 'm-1' },
	ownerEvents: events,
	opponentEvents: null,
}
const line = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ ...record, ...over })

describe('legacy game import records', () => {
	it('reads a good line and hashes the Discord id', () => {
		const parsed = parseLegacyGameRecord(line())
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		const row = toInsert(parsed.value, (id) => `h:${id}`)
		expect(row).toMatchObject({
			id: 12,
			discordIdHash: 'h:123456789012345678',
			betaSeason: 4,
			betaMatchKey: 'm-1',
			startedAt: new Date(record.startedAt),
		})
		expect(JSON.stringify(row)).not.toContain('"123456789012345678"')
	})

	it('keeps a game with no uploader link', () => {
		const parsed = parseLegacyGameRecord(
			line({ ownerDiscordId: null, beta: null }),
		)
		expect(
			parsed.ok && toInsert(parsed.value, () => 'x').discordIdHash,
		).toBeNull()
	})

	it.each([
		['id', { id: 0 }],
		['ownerDiscordId', { ownerDiscordId: 'abc' }],
		['startedAt', { startedAt: 'never' }],
		['result', { result: 'tie' }],
		['ownerEvents', { ownerEvents: 'not base64 gzip' }],
		['opponentEvents', { opponentEvents: compressToBase64('{"a":1}') }],
		['beta', { beta: { season: 'x' } }],
		['seed', { seed: 'x'.repeat(40) }],
	])('refuses a bad %s', (field, over) => {
		expect(parseLegacyGameRecord(line(over))).toEqual({
			ok: false,
			error: field,
		})
	})
})
