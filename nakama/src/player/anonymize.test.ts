import { readFileSync } from 'node:fs'
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
import { rpcAdminAccountDelete } from './admin'
import { DELETED_PLAYER_ID, DELETED_PLAYER_NAME } from './anonymize'

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

const KEEP_NOTHING = { keptRunIds: [], keepSteamIdHash: false }
const deleteAlice = (
	nk: unknown,
	body: object = { userId: ALICE, anonymousId: ANON, ...KEEP_NOTHING },
) =>
	JSON.parse(
		rpcAdminAccountDelete(
			serverCtx(),
			fakeLogger,
			nk as any,
			JSON.stringify(body),
		),
	)

function run(runId = 'run-1', withBob = true): RunRecord {
	const bob = <T>(v: T[]): T[] => (withBob ? v : [])
	return {
		runId,
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
			...bob([{ playerId: BOB, place: 2 }]),
		],
		reports: {
			[ALICE]: [
				{ playerId: ALICE, place: 1 },
				...bob([{ playerId: BOB, place: 2 }]),
			],
			...(withBob
				? {
						[BOB]: [
							{ playerId: BOB, place: 1 },
							{ playerId: ALICE, place: 2 },
						],
					}
				: {}),
		},
		reportOrder: [ALICE, ...bob([BOB])],
		players: [
			{ id: ALICE, displayName: 'Alice' },
			...bob([{ id: BOB, displayName: 'Bob' }]),
		],
		ratings: withBob
			? {
					[ALICE]: { before: 1000, after: 1010 } as never,
					[BOB]: { before: 1000, after: 990 } as never,
				}
			: { [ALICE]: { before: 1000, after: 1010 } as never },
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

describe('admin_account_delete', () => {
	it('needs an anonymous id and what to keep', () => {
		const { nk, gone } = setup()
		expect(() => deleteAlice(nk, { userId: ALICE, ...KEEP_NOTHING })).toThrow(
			/anonymousId/,
		)
		expect(() =>
			deleteAlice(nk, {
				userId: ALICE,
				anonymousId: ANON,
				keepSteamIdHash: false,
			}),
		).toThrow(/keptRunIds/)
		expect(() =>
			deleteAlice(nk, { userId: ALICE, anonymousId: ANON, keptRunIds: [] }),
		).toThrow(/keepSteamIdHash/)
		expect(gone).toEqual([])
	})

	it('gives a shared run the standard deleted-player id, keeps the other players whole and deletes the own log', () => {
		const { nk } = setup()
		nk.storageWrite(runWrites(run(), {}, () => 'h'))

		expect(deleteAlice(nk)).toEqual({ deleted: true })

		const record = stored(
			nk,
			RUNS_COLLECTION,
			SYSTEM_USER_ID,
			'run-1',
		) as RunRecord
		const D = DELETED_PLAYER_ID
		expect(JSON.stringify(record)).not.toContain(ALICE)
		expect(record.players).toEqual([
			{ id: D, displayName: '[deleted player]' },
			{ id: BOB, displayName: 'Bob' },
		])
		expect(record.placements).toEqual([
			{ playerId: D, place: 1 },
			{ playerId: BOB, place: 2 },
		])
		expect(record.reports[BOB]).toEqual([
			{ playerId: BOB, place: 1 },
			{ playerId: D, place: 2 },
		])
		expect(record.reportOrder).toEqual([D, BOB])
		expect(Object.keys(record.ratings || {})).toEqual([D, BOB])
		expect(record.flags).toEqual({ [D]: 'hash_mismatch' })

		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${ALICE}`),
		).toBeUndefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${D}`),
		).toBeUndefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${BOB}`),
		).toBeDefined()
		expect(
			nk.storageList(BOB, MY_RUNS_COLLECTION, 10, '').objects,
		).toHaveLength(1)
	})

	it('keeps a run an open report or ban uses, with its log, under the anonymous id', () => {
		const { nk } = setup()
		nk.storageWrite(runWrites(run(), {}, () => 'h'))

		deleteAlice(nk, {
			userId: ALICE,
			anonymousId: ANON,
			keptRunIds: ['run-1'],
			keepSteamIdHash: false,
		})

		const record = stored(
			nk,
			RUNS_COLLECTION,
			SYSTEM_USER_ID,
			'run-1',
		) as RunRecord
		expect(JSON.stringify(record)).not.toContain(ALICE)
		expect(record.players.map((p) => p.id)).toEqual([ANON, BOB])
		expect(record.players[0].displayName).toBe(DELETED_PLAYER_NAME)
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${ALICE}`),
		).toBeUndefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `run-1:${ANON}`),
		).toBeDefined()
	})

	it("deletes a run that is only the player's, unless an open report or ban uses it", () => {
		const { nk } = setup()
		nk.storageWrite(runWrites(run('solo', false), {}, () => 'h'))
		nk.storageWrite(runWrites(run('solo-kept', false), {}, () => 'h'))

		deleteAlice(nk, {
			userId: ALICE,
			anonymousId: ANON,
			keptRunIds: ['solo-kept'],
			keepSteamIdHash: false,
		})

		expect(stored(nk, RUNS_COLLECTION, SYSTEM_USER_ID, 'solo')).toBeUndefined()
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `solo:${ALICE}`),
		).toBeUndefined()
		const kept = stored(
			nk,
			RUNS_COLLECTION,
			SYSTEM_USER_ID,
			'solo-kept',
		) as RunRecord
		expect(kept.players.map((p) => p.id)).toEqual([ANON])
		expect(
			stored(nk, LOGS_COLLECTION, SYSTEM_USER_ID, `solo-kept:${ANON}`),
		).toBeDefined()
	})

	it('drops pending own mirror entries and keeps moderation ones under the anonymous id', () => {
		const { nk } = setup()
		const chat = (at: number, userId: string, flagged: boolean) =>
			enqueue(nk as any, {
				kind: 'chat',
				at,
				line: {
					lobbyCode: 'ABC123',
					lobbyId: 'l1',
					lobbyKind: null,
					userId,
					message: 'gg',
					flagged,
					verdict: null,
				},
			})
		enqueue(nk as any, { kind: 'notice', at: 1, userId: ALICE, version: 2 })
		chat(2, ALICE, false)
		chat(3, ALICE, true)
		chat(4, BOB, false)
		enqueue(nk as any, {
			kind: 'forfeit',
			at: 5,
			userId: ALICE,
			runId: 'r',
			code: 'ABC123',
			forfeitedAt: 4,
		})

		deleteAlice(nk)

		const entries = nk
			.storageList(SYSTEM_USER_ID, MIRROR_COLLECTION, 10, '')
			.objects.map((o: any) => o.value)
		expect(JSON.stringify(entries)).not.toContain(ALICE)
		expect(
			entries.map((e: any) => [e.kind, e.userId ?? e.line.userId]),
		).toEqual([
			['chat', ANON],
			['chat', BOB],
			['forfeit', ANON],
		])
	})

	it('keeps the ban index for a player with a ban record, and network bans, without the old id', () => {
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

		deleteAlice(nk, {
			userId: ALICE,
			anonymousId: ANON,
			keptRunIds: [],
			keepSteamIdHash: true,
		})

		expect(
			stored(
				nk,
				BAN_INDEX_COLLECTION,
				SYSTEM_USER_ID,
				`custom:steamhash:${hashOf(ALICE)}`,
			),
		).toEqual({
			userId: ANON,
			ban,
		})
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

	it('drops the ban index when the player has no ban record, as Postgres drops the hash', () => {
		const { nk } = setup()
		nk.storageWrite([
			{
				collection: BAN_INDEX_COLLECTION,
				key: `custom:steamhash:${hashOf(ALICE)}`,
				userId: SYSTEM_USER_ID,
				value: {
					userId: ALICE,
					ban: { banId: 'b1', reason: 'x', expiresAt: 1 },
				},
			},
		])
		deleteAlice(nk)
		expect(
			stored(
				nk,
				BAN_INDEX_COLLECTION,
				SYSTEM_USER_ID,
				`custom:steamhash:${hashOf(ALICE)}`,
			),
		).toBeUndefined()
	})

	it("deletes the player's legacy rating claim, banned or not", () => {
		const parked = { boards: [], claimedBy: ALICE, claimedAt: 1 }
		const { nk } = setup()
		nk.storageWrite([
			{
				collection: LEGACY_RATINGS_COLLECTION,
				key: hashOf(ALICE),
				userId: SYSTEM_USER_ID,
				value: parked,
			},
		])
		writeBans(nk as any, ALICE, {
			queue: { banId: 'b1', reason: 'cheating', expiresAt: null },
		})
		deleteAlice(nk, {
			userId: ALICE,
			anonymousId: ANON,
			keptRunIds: [],
			keepSteamIdHash: true,
		})
		expect(
			stored(nk, LEGACY_RATINGS_COLLECTION, SYSTEM_USER_ID, hashOf(ALICE)),
		).toBeUndefined()
	})

	it('deletes the lobby checkpoints and group parties that name the player', () => {
		const { nk } = setup()
		const seat = (id: string, name: string) => ({
			id,
			sessionId: '',
			info: { displayName: name },
			awaySince: 1,
		})
		const checkpoint = (code: string, ids: string[]) => ({
			collection: LOBBY_CHECKPOINT_COLLECTION,
			key: code,
			userId: SYSTEM_USER_ID,
			value: {
				at: 1,
				claimedAt: null,
				lobby: {
					code,
					hostId: ids[0],
					players: ids.map((id) => seat(id, id)),
					chat: [],
				},
			},
		})
		nk.storageWrite([
			checkpoint('ABC123', [ALICE, BOB]),
			checkpoint('XYZ789', [BOB]),
			{
				collection: BINDING_COLLECTION,
				key: 'party-1',
				userId: SYSTEM_USER_ID,
				value: { partyId: 'party-1', homeCode: 'ABC123', modId: 'M', memberIds: [ALICE, BOB] },
			},
			{
				collection: BINDING_COLLECTION,
				key: 'party-2',
				userId: SYSTEM_USER_ID,
				value: {
					partyId: 'party-2',
					homeCode: 'XYZ789',
					modId: 'M',
					memberIds: [BOB],
				},
			},
		])

		deleteAlice(nk)

		expect(
			stored(nk, LOBBY_CHECKPOINT_COLLECTION, SYSTEM_USER_ID, 'ABC123'),
		).toBeUndefined()
		expect(
			stored(nk, LOBBY_CHECKPOINT_COLLECTION, SYSTEM_USER_ID, 'XYZ789'),
		).toBeDefined()
		expect(
			stored(nk, BINDING_COLLECTION, SYSTEM_USER_ID, 'party-1'),
		).toBeUndefined()
		expect(
			stored(nk, BINDING_COLLECTION, SYSTEM_USER_ID, 'party-2'),
		).toBeDefined()
	})
})

describe('the standard deleted-player id', () => {
	it('is the same value the API uses', () => {
		const api = readFileSync(
			new URL(
				'../../../apps/server/src/shared/deleted-player.ts',
				import.meta.url,
			),
			'utf8',
		)
		expect(api).toContain(`DELETED_PLAYER_ID = '${DELETED_PLAYER_ID}'`)
		expect(api).toContain(`DELETED_PLAYER_NAME = '${DELETED_PLAYER_NAME}'`)
	})
})
