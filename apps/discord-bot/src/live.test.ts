import { describe, expect, it, vi } from 'vitest'
import { EXPANDED } from './ladders.js'
import { MAX_TRIES, createLiveUpdater } from './live.js'
import type { ChangesAnswer, FetchChanges } from './standings-client.js'
import type { GuildMemberInfo, SweepSummary } from './sweep.js'

const SUMMARY: SweepSummary = {
	membersChecked: 0,
	linked: 0,
	membersChanged: 0,
	rolesAdded: 0,
	rolesRemoved: 0,
	errors: 0,
	failedMemberIds: [],
	dryRun: false,
	durationMs: 0,
}

function row(playerId: string, updatedAt = '2026-11-19T12:00:00.000Z') {
	return { playerId, updatedAt }
}

function setup(
	answers: Partial<ChangesAnswer>[],
	members: GuildMemberInfo[] = [],
) {
	let n = 0
	const fetchChanges = vi.fn<FetchChanges>(async () => ({
		season: 3,
		cursor: `c${n}`,
		changed: [],
		top: [],
		...answers[n++],
	}))
	const sync = vi.fn(async (_ids: string[]): Promise<SweepSummary> => SUMMARY)
	const tick = createLiveUpdater({
		fetchChanges,
		ladders: [EXPANDED],
		links: new Map([
			['alice', 'p-alice'],
			['bob', 'p-bob'],
			['cara', 'p-cara'],
		]),
		leaderboardRoleIds: new Set(['r-foil', 'r-negative']),
		cachedMembers: () => members,
		sync,
	})
	return { tick, fetchChanges, sync }
}

describe('live updater', () => {
	it('starts from a cursor and the current top without syncing', async () => {
		const { tick, fetchChanges, sync } = setup([{ top: ['p-alice'] }])
		expect(await tick()).toBeNull()
		expect(fetchChanges).toHaveBeenCalledWith({
			modId: 'MultiplayerPvP',
			gameMode: 'ranked:pvp_ranked_expanded',
			topN: 50,
			since: null,
		})
		expect(sync).not.toHaveBeenCalled()
	})

	it('sends the last cursor back and does nothing when nobody moved', async () => {
		const { tick, fetchChanges, sync } = setup([
			{ top: ['p-alice'] },
			{ top: ['p-alice'], changed: [row('p-stranger')] },
		])
		await tick()
		expect(await tick()).toBeNull()
		expect(fetchChanges.mock.calls[1][0].since).toBe('c0')
		expect(sync).not.toHaveBeenCalled()
	})

	it('re-checks who played, the top and every leaderboard role holder', async () => {
		const members = [
			{ id: 'dave', name: 'dave', roleIds: ['r-foil'] },
			{ id: 'erin', name: 'erin', roleIds: ['r-gold'] },
		]
		const { tick, sync } = setup(
			[{ top: ['p-bob'] }, { top: ['p-bob'], changed: [row('p-alice')] }],
			members,
		)
		await tick()
		expect(await tick()).toBe(SUMMARY)
		expect(sync.mock.calls[0][0].sort()).toEqual(['alice', 'bob', 'dave'])
	})

	it('re-checks when the top changes even if no linked member played', async () => {
		// An unlinked player climbed into the top and pushed Bob down.
		const { tick, sync } = setup([
			{ top: ['p-bob', 'p-cara'] },
			{ top: ['p-stranger', 'p-bob'] },
		])
		await tick()
		await tick()
		expect(sync.mock.calls[0][0].sort()).toEqual(['bob'])
	})

	it('keeps the cursor and the top when a re-check fails', async () => {
		const { tick, fetchChanges, sync } = setup([
			{ top: ['p-bob'] },
			{ top: ['p-alice'], cursor: 'c1' },
			{ top: ['p-alice'], cursor: 'c2' },
		])
		await tick()
		sync.mockRejectedValueOnce(new Error('HTTP 503'))
		await expect(tick()).rejects.toThrow('HTTP 503')
		await tick()
		expect(fetchChanges.mock.calls[2][0].since).toBe('c0')
		expect(sync).toHaveBeenCalledTimes(2)
	})

	it('re-checks a row once, though the overlap returns it again', async () => {
		const { tick, sync } = setup([
			{},
			{ changed: [row('p-alice')] },
			{ changed: [row('p-alice')] },
			{ changed: [row('p-alice', '2026-11-19T12:05:00.000Z')] },
		])
		await tick()
		await tick()
		expect(await tick()).toBeNull()
		await tick()
		expect(sync).toHaveBeenCalledTimes(2)
	})

	it(`tries a failing role change ${MAX_TRIES} times in all`, async () => {
		const { tick, sync } = setup([{}, { changed: [row('p-alice')] }])
		sync.mockImplementation(async (ids) => ({
			...SUMMARY,
			errors: 1,
			failedMemberIds: ids.filter((id) => id === 'alice'),
		}))
		await tick()
		for (let i = 0; i < MAX_TRIES + 1; i++) await tick()
		expect(sync.mock.calls.map((c) => c[0])).toEqual(
			Array(MAX_TRIES).fill(['alice']),
		)
	})

	it('stops retrying once the change goes through', async () => {
		const { tick, sync } = setup([{}, { changed: [row('p-alice')] }])
		sync.mockResolvedValueOnce({
			...SUMMARY,
			errors: 1,
			failedMemberIds: ['alice'],
		})
		await tick()
		await tick()
		await tick()
		expect(await tick()).toBeNull()
		expect(sync).toHaveBeenCalledTimes(2)
	})
})
