import { describe, expect, it } from 'vitest'
import { claimLegacyRatingsAtLogin, claimLegacyRatings, LEGACY_RATINGS_COLLECTION, rpcLegacyRatingsImport } from './legacy'
import { fakeLogger, fakeNk as sharedFakeNk } from '../testing/fake_nk'

const HASH = 'a'.repeat(64)
const SYSTEM = '00000000-0000-0000-0000-000000000000'
const board = (over = {}) => ({
	modId: 'MultiplayerSPDRN', mode: 'ranked:x', season: 1, rating: 700, wins: 6, losses: 2,
	gamesPlayed: 8, seasonBest: 123000, lastMatchAt: 1_000, ...over,
})

function fakeNk() {
	const records: { id: string; owner: string; score: number }[] = []
	return sharedFakeNk({
		records,
		sha256Hash: (s: string) => (s === '76561198000000001salt' ? HASH : 'f'.repeat(64)),
		accountGetId: () => ({ user: { username: 'Bob' }, customId: 'steam:76561198000000001' }),
		leaderboardCreate: () => undefined,
		leaderboardRecordWrite: (id: string, owner: string, _n: string, score: number) => { records.push({ id, owner, score }) },
	})
}
const logger = fakeLogger
const server = { userId: '', env: {} } as unknown as nkruntime.Context
const player = { userId: 'u1', env: { PLAYER_ID_SALT: 'salt' } } as unknown as nkruntime.Context
const imp = (nk: any, players: object, ctx = server) => JSON.parse(rpcLegacyRatingsImport(ctx, logger, nk, JSON.stringify({ players }))!)

describe('legacy ratings import', () => {
	it('parks a valid player under the system user and skips malformed ones', () => {
		const nk = fakeNk()
		const r = imp(nk, { [HASH]: { boards: [board()] }, nothash: { boards: [] }, ['b'.repeat(64)]: { boards: [{ nope: 1 }] } })
		expect(r).toEqual({ imported: 1, alreadyClaimed: 0, skipped: 2 })
		expect(nk.objects.has(`${LEGACY_RATINGS_COLLECTION}/${SYSTEM}/${HASH}`)).toBe(true)
	})
	it('refuses a player session', () => {
		expect(() => imp(fakeNk(), { [HASH]: { boards: [] } }, player)).toThrow()
	})
})

describe('claiming at login', () => {
	it('moves boards onto the account, marks the claim and fills the leaderboard', () => {
		const nk = fakeNk()
		imp(nk, { [HASH]: { boards: [board(), board({ mode: 'ranked:y', gamesPlayed: 3 })] } })
		claimLegacyRatingsAtLogin(player, logger, nk as never)
		expect(nk.objects.get('ratings/u1/MultiplayerSPDRN:x:1')?.value.rating).toBe(700)
		expect(nk.objects.get('ratings/u1/MultiplayerSPDRN:y:1')?.value.gamesPlayed).toBe(3)
		expect(nk.records).toEqual([{ id: 'MultiplayerSPDRN:x:1', owner: 'u1', score: 700 }])
		expect(nk.objects.get(`${LEGACY_RATINGS_COLLECTION}/${SYSTEM}/${HASH}`)?.value.claimedBy).toBe('u1')
	})
	it('claims only once', () => {
		const nk = fakeNk()
		imp(nk, { [HASH]: { boards: [board()] } })
		expect(claimLegacyRatings(nk as never, logger, 'u1', 'Bob', HASH, 5)).toBe(1)
		expect(claimLegacyRatings(nk as never, logger, 'u2', 'Eve', HASH, 6)).toBe(0)
		expect(nk.objects.has('ratings/u2/MultiplayerSPDRN:x:1')).toBe(false)
	})
	it('keeps a board the account already has', () => {
		const nk = fakeNk()
		nk.objects.set('ratings/u1/MultiplayerSPDRN:x:1', { value: { rating: 900 }, version: 1 })
		imp(nk, { [HASH]: { boards: [board()] } })
		expect(claimLegacyRatings(nk as never, logger, 'u1', 'Bob', HASH, 5)).toBe(0)
		expect(nk.objects.get('ratings/u1/MultiplayerSPDRN:x:1')?.value.rating).toBe(900)
	})
	it('claims boards parked with the prefix onto the bare board', () => {
		const nk = fakeNk()
		nk.objects.set(`${LEGACY_RATINGS_COLLECTION}/${SYSTEM}/${HASH}`, { value: { boards: [board()] }, version: 1 })
		expect(claimLegacyRatings(nk as never, logger, 'u1', 'Bob', HASH, 5)).toBe(1)
		expect(nk.objects.get('ratings/u1/MultiplayerSPDRN:x:1')?.value.rating).toBe(700)
	})
	it('does nothing for a player with nothing parked, or without a salt', () => {
		const nk = fakeNk()
		claimLegacyRatingsAtLogin(player, logger, nk as never)
		claimLegacyRatingsAtLogin({ userId: 'u1', env: {} } as never, logger, nk as never)
		expect(nk.objects.size).toBe(0)
	})
	it('never throws out of the login hook', () => {
		const nk = fakeNk()
		nk.accountGetId = () => { throw new Error('boom') }
		expect(() => claimLegacyRatingsAtLogin(player, logger, nk as never)).not.toThrow()
	})
})
