import type { DiscordBotMember } from '@bmp/types'
import { type Ladder, topNeeded } from './ladders.js'
import {
	type MemberStanding,
	type RoleChanges,
	type Seasons,
	planRoleChanges,
	rolesForLadder,
} from './rank-logic.js'
import { type FetchStandings, IDS_PER_REQUEST } from './standings-client.js'

// One full pass over the guild: read every member, ask the API for their
// standings, work out each member's managed roles and apply the difference.
// Discord access is behind GuildPort so the pass is testable without it.

export interface GuildMemberInfo {
	id: string
	/** For logs only. */
	name: string
	roleIds: string[]
}

export interface GuildPort {
	listMembers(): Promise<GuildMemberInfo[]>
	/** One role at a time (PUT/DELETE on that one role), never a full role list. */
	addRole(memberId: string, roleId: string): Promise<void>
	removeRole(memberId: string, roleId: string): Promise<void>
	/** Members as last seen, without asking Discord (for per-match updates). */
	cachedMembers(): GuildMemberInfo[]
}

export interface SweepOptions {
	guild: GuildPort
	fetchStandings: FetchStandings
	ladders: Ladder[]
	/** Role name -> Discord role id, for every managed role. */
	roleIds: Record<string, string>
	dryRun: boolean
	/** Members changed at once, then a pause (Botlatro: 5 and 2 s). */
	batchSize?: number
	batchDelayMs?: number
	sleep?: (ms: number) => Promise<void>
	log?: (line: string) => void
	/** Discord id -> player id of linked members, kept up to date by each pass. */
	links?: Map<string, string>
}

export interface SweepSummary {
	membersChecked: number
	linked: number
	membersChanged: number
	rolesAdded: number
	rolesRemoved: number
	errors: number
	/** Members whose role change failed (not counting members who left). */
	failedMemberIds: string[]
	dryRun: boolean
	durationMs: number
}

/** A linked member's standing with their place, and who they are linked to. */
type LinkedMember = MemberStanding & { playerId: string }

interface PlannedChange extends RoleChanges {
	member: GuildMemberInfo
}

// Discord's "Unknown Member": they left between the member list and the change.
function isUnknownMember(err: unknown): boolean {
	return (err as { code?: unknown } | null)?.code === 10007
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Every ladder's standings for these members, keyed by ladder then Discord id.
 * Throws if any request fails: a pass with missing data would strip roles
 * from members it simply didn't hear about.
 *
 * Places come from the first request's top list alone, for every member: a
 * match finishing between two requests would otherwise rank members from two
 * board states (two #1s). Later requests skip the top (topN 0).
 */
async function loadStandings(
	fetchStandings: FetchStandings,
	ladders: Ladder[],
	memberIds: string[],
): Promise<
	Map<Ladder, { seasons: Seasons; players: Map<string, LinkedMember> }>
> {
	const out = new Map<
		Ladder,
		{ seasons: Seasons; players: Map<string, LinkedMember> }
	>()
	for (const ladder of ladders) {
		const players = new Map<string, LinkedMember>()
		let seasons: Seasons | null = null
		let rankOf: Map<string, number> | null = null
		for (const ids of chunk(memberIds, IDS_PER_REQUEST)) {
			const answer = await fetchStandings({
				modId: ladder.modId,
				gameMode: ladder.gameMode,
				topN: rankOf ? 0 : topNeeded(ladder),
				discordIds: ids,
			})
			// A season rolled over between two requests: start the pass again later.
			if (seasons && seasons.current !== answer.season)
				throw new Error('season changed during the sweep')
			seasons = { current: answer.season, previous: answer.previousSeason }
			rankOf ??= new Map(answer.top.map((playerId, i) => [playerId, i + 1]))
			for (const [id, standing] of Object.entries(answer.players))
				players.set(id, withRank(standing, rankOf))
		}
		out.set(ladder, {
			seasons: seasons ?? { current: 0, previous: null },
			players,
		})
	}
	return out
}

// The API's member with their place from `rankOf` (from one request's top).
function withRank(
	member: DiscordBotMember,
	rankOf: Map<string, number>,
): LinkedMember {
	return {
		playerId: member.playerId,
		current: member.current && {
			...member.current,
			rank: rankOf.get(member.playerId) ?? null,
		},
		previous: member.previous,
	}
}

/** Every member of the guild. */
export async function runSweep(opts: SweepOptions): Promise<SweepSummary> {
	const started = Date.now()
	const members = await opts.guild.listMembers()
	return syncMembers(opts, members, started, { everyone: true })
}

/** Just these members, from the member cache. Unknown ids are skipped. */
export async function syncSome(
	opts: SweepOptions,
	memberIds: Iterable<string>,
): Promise<SweepSummary> {
	const started = Date.now()
	const wanted = new Set(memberIds)
	const members = opts.guild.cachedMembers().filter((m) => wanted.has(m.id))
	return syncMembers(opts, members, started)
}

async function syncMembers(
	opts: SweepOptions,
	members: GuildMemberInfo[],
	started: number,
	{ everyone = false } = {},
): Promise<SweepSummary> {
	const log = opts.log ?? ((line: string) => console.log(line))
	const sleep = opts.sleep ?? defaultSleep
	const batchSize = opts.batchSize ?? 5
	const batchDelayMs = opts.batchDelayMs ?? 2000
	const managed = new Set(Object.values(opts.roleIds))
	const nameOf = new Map(
		Object.entries(opts.roleIds).map(([name, id]) => [
			id,
			name[0].toUpperCase() + name.slice(1),
		]),
	)

	const standings = await loadStandings(
		opts.fetchStandings,
		opts.ladders,
		members.map((m) => m.id),
	)
	// Only once the standings are in: a failed read keeps the last links, so
	// the per-match updates go on working until the next sweep. A full pass
	// rebuilds them, dropping members who left.
	if (everyone) opts.links?.clear()

	const linkedIds = new Set<string>()
	const plans: PlannedChange[] = []
	for (const member of members) {
		const wanted: string[] = []
		for (const ladder of opts.ladders) {
			const board = standings.get(ladder)
			if (!board) continue
			const standing = board.players.get(member.id)
			if (standing) {
				linkedIds.add(member.id)
				opts.links?.set(member.id, standing.playerId)
			}
			for (const role of rolesForLadder(ladder, standing, board.seasons))
				wanted.push(opts.roleIds[role])
		}
		if (!linkedIds.has(member.id)) opts.links?.delete(member.id)
		const changes = planRoleChanges(member.roleIds, wanted, managed)
		if (changes.add.length || changes.remove.length)
			plans.push({ member, ...changes })
	}

	const summary: SweepSummary = {
		membersChecked: members.length,
		linked: linkedIds.size,
		membersChanged: 0,
		rolesAdded: 0,
		rolesRemoved: 0,
		errors: 0,
		failedMemberIds: [],
		dryRun: opts.dryRun,
		durationMs: 0,
	}

	const describe = (p: PlannedChange) =>
		[
			...p.add.map((id) => `+${nameOf.get(id)}`),
			...p.remove.map((id) => `-${nameOf.get(id)}`),
		].join(' ')

	if (opts.dryRun) {
		for (const p of plans) {
			log(
				`[discord-bot] [dry-run] ${p.member.name} (${p.member.id}): ${describe(p)}`,
			)
			summary.membersChanged++
			summary.rolesAdded += p.add.length
			summary.rolesRemoved += p.remove.length
		}
	} else {
		const batches = chunk(plans, batchSize)
		for (const [i, batch] of batches.entries()) {
			await Promise.all(batch.map((p) => applyOne(p)))
			if (i < batches.length - 1) await sleep(batchDelayMs)
		}
	}

	async function applyOne(p: PlannedChange): Promise<void> {
		let changed = false
		try {
			for (const roleId of p.remove) {
				await opts.guild.removeRole(p.member.id, roleId)
				summary.rolesRemoved++
				changed = true
			}
			for (const roleId of p.add) {
				await opts.guild.addRole(p.member.id, roleId)
				summary.rolesAdded++
				changed = true
			}
			log(`[discord-bot] ${p.member.name} (${p.member.id}): ${describe(p)}`)
		} catch (err) {
			if (!isUnknownMember(err)) {
				summary.errors++
				summary.failedMemberIds.push(p.member.id)
				log(
					`[discord-bot] failed to update ${p.member.name} (${p.member.id}): ${(err as Error)?.message ?? err}`,
				)
			}
		}
		if (changed) summary.membersChanged++
	}

	summary.durationMs = Date.now() - started
	return summary
}

export function formatSummary(s: SweepSummary): string {
	const verb = s.dryRun ? 'would add' : 'added'
	const verb2 = s.dryRun ? 'would remove' : 'removed'
	return [
		`Checked ${s.membersChecked} members (${s.linked} linked).`,
		`${s.dryRun ? 'Would change' : 'Changed'} ${s.membersChanged}: ${verb} ${s.rolesAdded} roles, ${verb2} ${s.rolesRemoved}.`,
		`Errors: ${s.errors}. Took ${Math.round(s.durationMs / 1000)}s.`,
		...(s.dryRun
			? ['Dry run: nothing was changed (set DRY_RUN=false to apply).']
			: []),
	].join(' ')
}
