import { describe, expect, it, vi } from 'vitest'
import { EXPANDED } from './ladders.js'
import type { MemberStanding } from './rank-logic.js'
import type { FetchStandings } from './standings-client.js'
import { type GuildMemberInfo, type GuildPort, runSweep } from './sweep.js'

const roleIds: Record<string, string> = {
	stone: 'r-stone',
	steel: 'r-steel',
	gold: 'r-gold',
	lucky: 'r-lucky',
	glass: 'r-glass',
	negative: 'r-negative',
	polychrome: 'r-polychrome',
	holographic: 'r-holographic',
	foil: 'r-foil',
}

function fakeGuild(members: GuildMemberInfo[]) {
	const calls: string[] = []
	const guild: GuildPort = {
		listMembers: async () => members,
		addRole: vi.fn(async (m: string, r: string) => {
			calls.push(`+${m}:${r}`)
		}),
		removeRole: vi.fn(async (m: string, r: string) => {
			calls.push(`-${m}:${r}`)
		}),
	}
	return { guild, calls }
}

// Like the API: player ids are `p-<discord id>`, and the top list (only when
// asked for) puts each ranked player at their place (others fill the gaps).
function standingsOf(players: Record<string, MemberStanding>): FetchStandings {
	return async (req) => {
		const top: string[] = []
		for (const [id, s] of Object.entries(players))
			if (s.current?.rank != null) top[s.current.rank - 1] = `p-${id}`
		return {
			season: 3,
			previousSeason: 2,
			players: Object.fromEntries(
				Object.entries(players)
					.filter(([id]) => req.discordIds.includes(id))
					.map(([id, { current, previous }]) => [
						id,
						{
							playerId: `p-${id}`,
							current: current && {
								gamesPlayed: current.gamesPlayed,
								rating: current.rating,
							},
							previous,
						},
					]),
			),
			top:
				req.topN > 0
					? Array.from(top, (p, i) => p ?? `p-someone-${i + 1}`)
					: [],
		}
	}
}

const settled = (
	rating: number,
	rank: number | null = null,
): MemberStanding => ({
	current: { gamesPlayed: 40, rating, rank },
	previous: null,
})

const base = {
	ladders: [EXPANDED],
	roleIds,
	sleep: async () => {},
	log: () => {},
}

describe('runSweep', () => {
	it('promotes, strips the unlinked and leaves other roles alone', async () => {
		const { guild, calls } = fakeGuild([
			{ id: 'alice', name: 'alice', roleIds: ['r-steel', 'mod'] },
			{ id: 'bob', name: 'bob', roleIds: ['r-gold', 'r-foil', 'booster'] },
			{ id: 'cara', name: 'cara', roleIds: ['r-gold'] },
		])
		const summary = await runSweep({
			...base,
			guild,
			dryRun: false,
			fetchStandings: standingsOf({
				alice: settled(760, 20),
				cara: settled(760),
			}),
		})
		// Members in a batch run side by side; each member's removes come first.
		expect(calls.filter((c) => c.includes('alice'))).toEqual([
			'-alice:r-steel',
			'+alice:r-gold',
			'+alice:r-foil',
		])
		expect(calls.filter((c) => c.includes('bob'))).toEqual([
			'-bob:r-gold',
			'-bob:r-foil',
		])
		expect(calls).toHaveLength(5)
		expect(summary).toMatchObject({
			membersChecked: 3,
			linked: 2,
			membersChanged: 2,
			rolesAdded: 2,
			rolesRemoved: 3,
			errors: 0,
		})
	})

	it('changes nothing in a dry run but logs and counts the plan', async () => {
		const { guild, calls } = fakeGuild([
			{ id: 'alice', name: 'alice', roleIds: ['r-steel'] },
		])
		const lines: string[] = []
		const summary = await runSweep({
			...base,
			guild,
			dryRun: true,
			log: (l) => lines.push(l),
			fetchStandings: standingsOf({ alice: settled(760) }),
		})
		expect(calls).toEqual([])
		expect(lines).toEqual([
			'[discord-bot] [dry-run] alice (alice): +Gold -Steel',
		])
		expect(summary).toMatchObject({
			dryRun: true,
			membersChanged: 1,
			rolesAdded: 1,
			rolesRemoved: 1,
		})
	})

	it('changes nothing when the standings request fails', async () => {
		const { guild, calls } = fakeGuild([
			{ id: 'alice', name: 'alice', roleIds: ['r-gold'] },
		])
		const fetchStandings: FetchStandings = async () => {
			throw new Error('HTTP 503')
		}
		await expect(
			runSweep({ ...base, guild, dryRun: false, fetchStandings }),
		).rejects.toThrow('HTTP 503')
		expect(calls).toEqual([])
	})

	it('aborts if the season changes between requests', async () => {
		const members = Array.from({ length: 1001 }, (_, i) => ({
			id: `m${i}`,
			name: `m${i}`,
			roleIds: ['r-gold'],
		}))
		const { guild, calls } = fakeGuild(members)
		let season = 3
		const fetchStandings: FetchStandings = async () => ({
			season: season++,
			previousSeason: 2,
			players: {},
			top: [],
		})
		await expect(
			runSweep({ ...base, guild, dryRun: false, fetchStandings }),
		).rejects.toThrow('season changed')
		expect(calls).toEqual([])
	})

	it('asks for at most 1000 ids per request and the top 50 once', async () => {
		const members = Array.from({ length: 2500 }, (_, i) => ({
			id: `m${i}`,
			name: `m${i}`,
			roleIds: [],
		}))
		const { guild } = fakeGuild(members)
		const fetchStandings = vi.fn(standingsOf({}))
		await runSweep({ ...base, guild, dryRun: true, fetchStandings })
		expect(fetchStandings.mock.calls.map(([r]) => r.discordIds.length)).toEqual(
			[1000, 1000, 500],
		)
		expect(fetchStandings.mock.calls[0][0]).toMatchObject({
			modId: 'MultiplayerPvP',
			gameMode: 'ranked:pvp_ranked_expanded',
			topN: 50,
		})
		expect(fetchStandings.mock.calls.map(([r]) => r.topN)).toEqual([50, 0, 0])
	})

	it("ranks every member from the first request's top list", async () => {
		// m1000 is in the second request. A match between the requests moved
		// them to #1, but the first request's list still has m0 there.
		const members = Array.from({ length: 1001 }, (_, i) => ({
			id: `m${i}`,
			name: `m${i}`,
			roleIds: [] as string[],
		}))
		const { guild, calls } = fakeGuild(members)
		const fetchStandings: FetchStandings = async (req) => {
			const first = req.discordIds.includes('m0')
			const id = first ? 'm0' : 'm1000'
			return {
				season: 3,
				previousSeason: 2,
				players: {
					[id]: {
						playerId: `p-${id}`,
						current: { gamesPlayed: 40, rating: 1300 },
						previous: null,
					},
				},
				top: first ? ['p-m0', 'p-m1000'] : [],
			}
		}
		await runSweep({ ...base, guild, dryRun: false, fetchStandings })
		expect(calls.filter((c) => c.endsWith('r-negative'))).toEqual([
			'+m0:r-negative',
		])
		expect(calls).toContain('+m1000:r-polychrome')
	})

	it('changes 5 members at a time with a pause between batches', async () => {
		const members = Array.from({ length: 12 }, (_, i) => ({
			id: `m${i}`,
			name: `m${i}`,
			roleIds: ['r-gold'],
		}))
		const { guild } = fakeGuild(members)
		const sleep = vi.fn(async () => {})
		await runSweep({
			...base,
			guild,
			dryRun: false,
			sleep,
			fetchStandings: standingsOf({}),
		})
		expect(sleep.mock.calls).toEqual([[2000], [2000]])
	})

	it('skips members who left and counts other errors', async () => {
		const { guild } = fakeGuild([
			{ id: 'gone', name: 'gone', roleIds: ['r-gold'] },
			{ id: 'stuck', name: 'stuck', roleIds: ['r-gold'] },
			{ id: 'fine', name: 'fine', roleIds: ['r-gold'] },
		])
		guild.removeRole = async (member) => {
			if (member === 'gone')
				throw Object.assign(new Error('Unknown Member'), { code: 10007 })
			if (member === 'stuck')
				throw Object.assign(new Error('Missing Permissions'), { code: 50013 })
		}
		const summary = await runSweep({
			...base,
			guild,
			dryRun: false,
			fetchStandings: standingsOf({}),
		})
		expect(summary).toMatchObject({
			errors: 1,
			membersChanged: 1,
			rolesRemoved: 1,
		})
	})
})
