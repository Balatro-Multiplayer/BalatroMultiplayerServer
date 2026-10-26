import { describe, expect, it } from 'vitest'
import {
	LOBBY_CHECKPOINT_COLLECTION,
	LOGS_COLLECTION,
	MY_RUNS_COLLECTION,
	RUNS_COLLECTION,
	type RunRecord,
	SYSTEM_USER_ID,
} from '../lobby/protocol'
import { runWrites } from '../lobby/storage'
import { MIRROR_COLLECTION, enqueue } from '../mirror/outbox'
import { BAN_INDEX_COLLECTION } from '../moderation/enforce'
import { writeBans } from '../moderation/bans'
import { LEGACY_RATINGS_COLLECTION } from '../rating/legacy'
import { BINDING_COLLECTION } from '../matchmaking/group/binding'
import {
	IP_HASHES_COLLECTION,
	IP_HASHES_KEY,
	NETWORK_BANS_COLLECTION,
	recordNetworkLogin,
} from '../moderation/network'
import { fakeLogger, fakeNk, serverCtx } from '../testing/fake_nk'
import { DELETED_PLAYER_NAME } from './anonymize'
import { rpcAdminAccountDelete } from './admin'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const ANON = '99999999-9999-4999-8999-999999999999'
// A Steam id hash per test account, as Steam login names it.
const hashOf = (id: string) => id.charAt(0).repeat(64)

function setup() {
	const gone: string[] = []
	let nextUuid = 0
	const nk = fakeNk({
		accountGetId: (id: string) => {
			if (gone.indexOf(id) !== -1 || (id !== ALICE && id !== BOB))
				throw new Error('not found')
			return {
				user: { id, username: id, displayName: id },
				customId: `steamhash:${hashOf(id)}`,
			}
		},
		sessionLogout: () => undefined,
		uuidv4: () => {
			nextUuid += 1
			return `u${nextUuid}`
		},
		accountDeleteId: (id: string) => gone.push(id),
	})
	return { nk, gone }
}

const deleteAlice = (
	nk: unknown,
	body: object = { userId: ALICE, anonymousId: ANON },
) =>
	JSON.parse(
		rpcAdminAccountDelete(
			serverCtx(),
			fakeLogger,
			nk as any,
			JSON.stringify(body),
		),
	)

function run(): RunRecord {
	return {
		runId: 'run-1',
		code: 'ABC123',
		modId: 'M',
		seed: 'S',
		stake: 1,
		options: {},
		startedAt: 1000,
		endedAt: 2000,
		status: 'disputed',
		placements: [
			{ playerId: ALICE, place: 1 },
			{ playerId: BOB, place: 2 },
		],
		reports: {
			[ALICE]: [
				{ playerId: ALICE, place: 1 },
				{ playerId: BOB, place: 2 },
			],
			[BOB]: [
				{ playerId: BOB, place: 1 },
				{ playerId: ALICE, place: 2 },
			],
		},
		reportOrder: [ALICE, BOB],
		players: [
			{ id: ALICE, displayName: 'Alice' },
			{ id: BOB, displayName: 'Bob' },
		],
		ratings: {
			[ALICE]: { before: 1000, after: 1010 } as never,
			[BOB]: { before: 1000, after: 990 } as never,
		},
		flags: { [ALICE]: 'hash_mismatch' },
	}
}

function stored(
	nk: { objects: Map<string, { value: any }> },
	collection: string,
	userId: string,
	key: string,
) {
	return nk.objects.get(`${collection}/${userId}/${key}`)?.value
}

describe('admin_account_delete anonymizes the account', () => {
	it('needs an anonymous id', () => {
		const { nk, gone } = setup()
		expect(() => deleteAlice(nk, { userId: ALICE })).toThrow(/anonymousId/)
		expect(gone).toEqual([])
	})

	it('replaces the player in their runs and keeps the other players whole', () => {
		const { nk } = setup()
		nk.storageWrite(runWrites(run(), {}, () => 'h'))

		expect(deleteAlice(nk)).toEqual({ deleted: true })

		const record = stored(
			nk,
			RUNS_COLLECTION,
			SYSTEM_USER_ID,
			'run-1',
		) as RunRecord
		expect(JSON.stringify(record)).not.toContain(ALICE)
		expect(record.players).toEqual([
			{ id: ANON, displayName: '[deleted player]' },
			{ id: BOB, displayName: 'Bob' },
		])
		expect(record.placements).toEqual([
			{ playerId: ANON, place: 1 },
			{ playerId: BOB, place: 2 },
		])
		expect(record.reports[BOB]).toEqual([
			{ playerId: BOB, place: 1 },
			{ playerId: ANON, place: 2 },
		])
		expect(record.reports[ANON]).toEqual([
			{ playerId: ANON, place: 1 },
			{ playerId: BOB, place: 2 },
		])
		expect(record.reportOrder).toEqual([ANON, BOB])
		expect(Object.keys(record.ratings || {})).toEqual([ANON, BOB])
		expect(record.flags).toEqual({ [ANON]: 'hash_mismatch' })
		expect(Object.keys((record as any).logChecks)).toEqual([ANON, BOB])

		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${ALICE}`),
		).toBeUndefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${ANON}`),
		).toBeDefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${BOB}`),
		).toBeDefined()
		const bobRuns = nk.storageList(BOB, MY_RUNS_COLLECTION, 10, '').objects
		expect(bobRuns).toHaveLength(1)
	})

	it('rewrites the pending mirror entries, so the API never sees the old id', () => {
		const { nk } = setup()
		enqueue(nk as any, { kind: 'notice', at: 1, userId: ALICE, version: 2 })
		enqueue(nk as any, {
			kind: 'chat',
			at: 2,
			line: {
				lobbyCode: 'ABC123',
				lobbyId: 'l1',
				lobbyKind: null,
				userId: ALICE,
				message: 'gg',
				flagged: false,
				verdict: null,
			},
		})
		enqueue(nk as any, {
			kind: 'chat',
			at: 3,
			line: {
				lobbyCode: 'ABC123',
				lobbyId: 'l1',
				lobbyKind: null,
				userId: BOB,
				message: 'hi',
				flagged: false,
				verdict: null,
			},
		})

		deleteAlice(nk)

		const entries = nk
			.storageList(SYSTEM_USER_ID, MIRROR_COLLECTION, 10, '')
			.objects.map((o: any) => o.value)
		expect(JSON.stringify(entries)).not.toContain(ALICE)
		expect(entries.map((e: any) => e.userId ?? e.line.userId)).toEqual([
			ANON,
			ANON,
			BOB,
		])
	})

	it('keeps the ban index and network bans for ban enforcement, without the old id', () => {
		const { nk } = setup()
		const ban = { banId: 'b1', reason: 'cheating', expiresAt: null }
		nk.storageWrite([
			{
				collection: BAN_INDEX_COLLECTION,
				key: `custom:steamhash:${hashOf(ALICE)}`,
				userId: SYSTEM_USER_ID,
				value: { userId: ALICE, ban },
			},
			{
				collection: NETWORK_BANS_COLLECTION,
				key: 'b1',
				userId: SYSTEM_USER_ID,
				value: {
					banId: 'b1',
					userId: ALICE,
					hashes: ['h1'],
					bannedAt: 1,
					liftedAt: null,
				},
			},
		])
		recordNetworkLogin(nk as any, ALICE, 'h1', Date.now())

		deleteAlice(nk)

		expect(
			stored(
				nk,
				BAN_INDEX_COLLECTION,
				SYSTEM_USER_ID,
				`custom:steamhash:${hashOf(ALICE)}`,
			),
		).toEqual({ userId: ANON, ban })
		expect(stored(nk, NETWORK_BANS_COLLECTION, SYSTEM_USER_ID, 'b1')).toEqual({
			banId: 'b1',
			userId: ANON,
			hashes: ['h1'],
			bannedAt: 1,
			liftedAt: null,
		})
		expect(
			stored(nk, IP_HASHES_COLLECTION, ALICE, IP_HASHES_KEY),
		).toBeUndefined()
	})

	it("frees a claimed legacy rating's Steam id hash, unless the player is banned", () => {
		const parked = (claimedBy: string) => ({ boards: [], claimedBy, claimedAt: 1 })
		const free = setup()
		free.nk.storageWrite([
			{ collection: LEGACY_RATINGS_COLLECTION, key: hashOf(ALICE), userId: SYSTEM_USER_ID, value: parked(ALICE) },
		])
		deleteAlice(free.nk)
		expect(stored(free.nk, LEGACY_RATINGS_COLLECTION, SYSTEM_USER_ID, hashOf(ALICE))).toBeUndefined()

		const banned = setup()
		banned.nk.storageWrite([
			{ collection: LEGACY_RATINGS_COLLECTION, key: hashOf(ALICE), userId: SYSTEM_USER_ID, value: parked(ALICE) },
		])
		writeBans(banned.nk as any, ALICE, { queue: { banId: 'b1', reason: 'cheating', expiresAt: null } })
		deleteAlice(banned.nk)
		expect(stored(banned.nk, LEGACY_RATINGS_COLLECTION, SYSTEM_USER_ID, hashOf(ALICE))).toEqual(parked(ANON))
	})

	it('replaces the player in lobby checkpoints and group parties, without their name', () => {
		const { nk } = setup()
		const seat = (id: string, name: string) => ({ id, sessionId: '', info: { displayName: name }, awaySince: 1 })
		nk.storageWrite([
			{
				collection: LOBBY_CHECKPOINT_COLLECTION,
				key: 'ABC123',
				userId: SYSTEM_USER_ID,
				value: {
					at: 1,
					claimedAt: null,
					lobby: {
						code: 'ABC123',
						hostId: ALICE,
						players: [seat(ALICE, 'Alice'), seat(BOB, 'Bob')],
						chat: [{ senderId: ALICE, displayName: 'Alice', text: 'gg' }],
					},
				},
			},
			{
				collection: BINDING_COLLECTION,
				key: 'party-1',
				userId: SYSTEM_USER_ID,
				value: { partyId: 'party-1', homeCode: 'ABC123', modId: 'M', memberIds: [ALICE, BOB] },
			},
		])

		deleteAlice(nk)

		const lobby = stored(nk, LOBBY_CHECKPOINT_COLLECTION, SYSTEM_USER_ID, 'ABC123').lobby
		expect(lobby.hostId).toBe(ANON)
		expect(lobby.players).toEqual([seat(ANON, DELETED_PLAYER_NAME), seat(BOB, 'Bob')])
		expect(lobby.chat).toEqual([{ senderId: ANON, displayName: DELETED_PLAYER_NAME, text: 'gg' }])
		expect(JSON.stringify(lobby)).not.toContain('Alice')
		expect(stored(nk, BINDING_COLLECTION, SYSTEM_USER_ID, 'party-1').memberIds).toEqual([ANON, BOB])
	})
})
