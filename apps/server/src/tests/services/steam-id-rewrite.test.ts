import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
	INakamaAccountRepository,
	SteamIdRewritePlan,
} from '../../contracts/INakamaAccountRepository.js'
import { rewriteSteamIds } from '../../features/nakama/steam-id-rewrite.service.js'

const ALICE = '76561198000000001'
const BOB = '76561198000000002'
// sha256(<id> + 'pepper'), worked out once by hand.
const ALICE_HASH =
	'dcd52e52066edc9e05b6b85944a5d20bbb703e11de4b075c7cab8e4810b8f72d'
const BOB_HASH =
	'533d37e5d955c428bc004303d29183dc9cf98861b9c78b4181a0a404fd268c9e'
const hash = (steamId: string) =>
	createHash('sha256')
		.update(`${steamId}pepper`)
		.digest('hex')

const RAW_CUSTOM_ID = /^steam:(\d+)$/
const RAW_BAN_KEY = /^custom:steam:(\d+)$/

// Nakama's users.custom_id and the ban_index keys, in memory.
function fakeNakama(
	customIds: { [userId: string]: string },
	banKeys: string[],
) {
	const users = new Map(Object.entries(customIds))
	const bans = new Set(banKeys)
	let onRead: () => void = () => {}
	const repo: INakamaAccountRepository = {
		async findRawSteamLogins() {
			const found = {
				accounts: [...users].flatMap(([userId, id]) => {
					const m = RAW_CUSTOM_ID.exec(id)
					return m ? [{ userId, steamId: m[1] }] : []
				}),
				bannedSteamIds: [...bans].flatMap((key) => {
					const m = RAW_BAN_KEY.exec(key)
					return m ? [m[1]] : []
				}),
			}
			onRead()
			return found
		},
		async applySteamIdRewrite(plan: SteamIdRewritePlan) {
			for (const { userId, customId } of plan.accounts)
				users.set(userId, customId)
			for (const { from, to } of plan.banKeys) {
				bans.delete(from)
				bans.add(to)
			}
		},
		async countRawSteamLogins() {
			return (
				[...users.values()].filter((id) => RAW_CUSTOM_ID.test(id)).length +
				[...bans].filter((k) => RAW_BAN_KEY.test(k)).length
			)
		},
	}
	const afterRead = (fn: () => void) => {
		onRead = fn
	}
	return { repo, users, bans, afterRead }
}

describe('the Steam id rewrite', () => {
	it('names every raw Steam id account and ban index entry by its hash', async () => {
		const nakama = fakeNakama(
			{
				u1: `steam:${ALICE}`,
				u2: `steam:${BOB}`,
				u3: '',
				u4: `steamhash:${'0'.repeat(64)}`,
			},
			[`custom:steam:${ALICE}`, 'device:bmp-dev-TestPlayer1'],
		)
		const result = await rewriteSteamIds(nakama.repo, hash)
		expect(result).toEqual({ renamed: 2, banKeysMoved: 1, left: 0 })
		expect(Object.fromEntries(nakama.users)).toEqual({
			u1: `steamhash:${ALICE_HASH}`,
			u2: `steamhash:${BOB_HASH}`,
			u3: '',
			u4: `steamhash:${'0'.repeat(64)}`,
		})
		expect([...nakama.bans].sort()).toEqual([
			`custom:steamhash:${ALICE_HASH}`,
			'device:bmp-dev-TestPlayer1',
		])
	})

	it('is safe to run again', async () => {
		const nakama = fakeNakama({ u1: `steam:${ALICE}` }, [
			`custom:steam:${ALICE}`,
		])
		await rewriteSteamIds(nakama.repo, hash)
		expect(await rewriteSteamIds(nakama.repo, hash)).toEqual({
			renamed: 0,
			banKeysMoved: 0,
			left: 0,
		})
		expect(nakama.users.get('u1')).toBe(`steamhash:${ALICE_HASH}`)
	})

	it('reports a raw Steam id account it did not move, as when Nakama was still running', async () => {
		const nakama = fakeNakama({ u1: `steam:${ALICE}` }, [])
		nakama.afterRead(() => {
			nakama.users.set('u2', `steam:${BOB}`)
		})
		expect(await rewriteSteamIds(nakama.repo, hash)).toEqual({
			renamed: 1,
			banKeysMoved: 0,
			left: 1,
		})
	})
})
