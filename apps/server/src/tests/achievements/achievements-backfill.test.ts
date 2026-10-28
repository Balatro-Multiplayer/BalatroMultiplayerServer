import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type BackfillPage,
	backfillAchievements,
	fillAchievementsAtBoot,
} from '../../features/achievements/achievements-backfill.service.js'
import type { NakamaRpcError } from '../../infrastructure/nakama/admin-client.js'
import { type Result, err, ok } from '../../shared/utils/result.js'

const page = (over: Partial<BackfillPage> = {}): BackfillPage => ({
	enabled: true,
	done: false,
	filled: 0,
	skipped: 0,
	failed: 0,
	cursor: '',
	...over,
})

type Answer = Result<BackfillPage, NakamaRpcError>

function nakama(answers: Answer[]) {
	const calls: Record<string, unknown>[] = []
	const call = vi.fn(async (body: Record<string, unknown>) => {
		calls.push(body)
		return answers.shift() ?? ok(page({ done: true }))
	})
	return { call, calls }
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {})
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('backfillAchievements', () => {
	it('follows the cursor to the end and adds up the pages', async () => {
		const { call, calls } = nakama([
			ok(page({ filled: 3, skipped: 1, cursor: 'c1' })),
			ok(page({ filled: 2, failed: 1, done: true })),
		])
		const result = await backfillAchievements({ force: true }, call)
		expect(result).toEqual(ok({ filled: 5, skipped: 1, failed: 1 }))
		expect(calls).toEqual([
			{ cursor: '', force: true },
			{ cursor: 'c1', force: true },
		])
	})

	it('reports achievements off, or Nakama not answering', async () => {
		expect(
			await backfillAchievements(
				{},
				nakama([ok(page({ enabled: false }))]).call,
			),
		).toEqual(err('off'))
		expect(
			await backfillAchievements({}, nakama([err('unreachable')]).call),
		).toEqual(err('unreachable'))
	})
})

describe('fillAchievementsAtBoot', () => {
	it('pushes the config first, then fills, retrying while Nakama is not ready', async () => {
		const order: string[] = []
		const { call } = nakama([
			err('unreachable'),
			ok(page({ enabled: false })),
			ok(page({ filled: 4, done: true })),
		])
		const sleep = vi.fn(async () => {
			order.push('sleep')
		})
		await fillAchievementsAtBoot({
			pushConfig: async () => {
				order.push('push')
				return true
			},
			call: async (body) => {
				order.push('call')
				return call(body)
			},
			sleep,
		})
		expect(order).toEqual(['push', 'call', 'sleep', 'call', 'sleep', 'call'])
	})

	it('gives up after a few tries and never throws', async () => {
		const call = vi.fn(async (): Promise<Answer> => err('unreachable'))
		await expect(
			fillAchievementsAtBoot({
				pushConfig: async () => false,
				call,
				sleep: async () => {},
			}),
		).resolves.toBeUndefined()
		expect(call.mock.calls.length).toBeGreaterThan(1)
		const throwing = vi.fn(async (): Promise<Answer> => {
			throw new Error('boom')
		})
		await expect(
			fillAchievementsAtBoot({
				pushConfig: async () => true,
				call: throwing,
				sleep: async () => {},
			}),
		).resolves.toBeUndefined()
	})

	it('stops at the first refusal that waiting cannot fix', async () => {
		const call = vi.fn(async (): Promise<Answer> => err('rejected'))
		await fillAchievementsAtBoot({
			pushConfig: async () => true,
			call,
			sleep: async () => {},
		})
		expect(call).toHaveBeenCalledTimes(1)
	})
})
