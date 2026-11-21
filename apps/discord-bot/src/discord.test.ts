import {
	Client,
	ClientUser,
	type Guild,
	PermissionFlagsBits,
	PermissionsBitField,
} from 'discord.js'
import { afterEach, describe, expect, it } from 'vitest'
import { SYNC_COMMAND, guildPort, rolePlacementProblems } from './discord.js'

// Real discord.js objects (Client, Guild, members, roles), with the REST
// client swapped for a recorder: the tests see the exact HTTP calls the bot
// would send to Discord, and nothing reaches the network.

const GUILD_ID = '100'
const BOT_ID = '900'
const BOT_ROLE = '50'
const MANAGE_ROLES = String(PermissionFlagsBits.ManageRoles)

type RoleData = {
	id: string
	position: number
	permissions?: string
	managed?: boolean
}
type MemberData = { id: string; roles: string[] }

function roleJson(r: RoleData) {
	return {
		id: r.id,
		name: `role-${r.id}`,
		position: r.position,
		permissions: r.permissions ?? '0',
		managed: r.managed ?? false,
		color: 0,
		hoist: false,
		mentionable: false,
		flags: 0,
	}
}

function memberJson(m: MemberData) {
	return {
		user: {
			id: m.id,
			username: `user-${m.id}`,
			discriminator: '0',
			avatar: null,
		},
		roles: m.roles,
		joined_at: new Date(0).toISOString(),
	}
}

const clients: Client[] = []
afterEach(async () => {
	await Promise.all(clients.splice(0).map((c) => c.destroy()))
})

// A server with @everyone (position 0), the bot's role at position 5 with the
// given permissions, any extra roles and members, and the bot as a member
// unless botMember is false.
function makeGuild(opts: {
	botPermissions?: string
	roles?: RoleData[]
	members?: MemberData[]
	botMember?: boolean
	failWith?: unknown
}) {
	const client = new Client({ intents: [] })
	clients.push(client)
	;(client as { user: ClientUser | null }).user = new ClientUser(client, {
		id: BOT_ID,
		username: 'rank-bot',
		discriminator: '0',
		avatar: null,
	})
	const calls: {
		method: string
		route: string
		body: unknown
		reason: unknown
	}[] = []
	const rest = client.rest as unknown as Record<string, unknown>
	for (const method of ['get', 'put', 'delete', 'patch', 'post']) {
		rest[method] = async (
			route: string,
			o: { body?: unknown; reason?: unknown } = {},
		) => {
			calls.push({
				method: method.toUpperCase(),
				route,
				body: o.body,
				reason: o.reason,
			})
			if (opts.failWith) throw opts.failWith
			return {}
		}
	}
	const members = [...(opts.members ?? [])]
	if (opts.botMember !== false) members.push({ id: BOT_ID, roles: [BOT_ROLE] })
	const guild = (
		client.guilds as unknown as { _add(data: unknown): Guild }
	)._add({
		id: GUILD_ID,
		name: 'Test server',
		owner_id: '1',
		unavailable: false,
		roles: [
			{ id: GUILD_ID, position: 0 }, // @everyone
			{
				id: BOT_ROLE,
				position: 5,
				permissions: opts.botPermissions ?? MANAGE_ROLES,
			},
			...(opts.roles ?? []),
		].map(roleJson),
		members: members.map(memberJson),
	})
	return { guild, calls }
}

describe('guildPort', () => {
	it('adds a role with one PUT for that role alone', async () => {
		const { guild, calls } = makeGuild({
			roles: [
				{ id: '20', position: 2 },
				{ id: '30', position: 1 },
			],
			members: [{ id: '7', roles: ['30'] }],
		})
		await guildPort(guild).addRole('7', '20')
		expect(calls).toEqual([
			{
				method: 'PUT',
				route: `/guilds/${GUILD_ID}/members/7/roles/20`,
				body: undefined,
				reason: 'Rank role sync',
			},
		])
	})

	it('removes a role with one DELETE for that role alone', async () => {
		const { guild, calls } = makeGuild({
			roles: [
				{ id: '20', position: 2 },
				{ id: '30', position: 1 },
			],
			members: [{ id: '7', roles: ['20', '30'] }],
		})
		await guildPort(guild).removeRole('7', '20')
		expect(calls).toEqual([
			{
				method: 'DELETE',
				route: `/guilds/${GUILD_ID}/members/7/roles/20`,
				body: undefined,
				reason: 'Rank role sync',
			},
		])
	})

	// A PATCH of the member with a roles list would replace all their roles
	// from a possibly stale cache (the Botlatro bug).
	it('never sends a member update, whatever is in the cache', async () => {
		const { guild, calls } = makeGuild({
			roles: [
				{ id: '20', position: 2 },
				{ id: '30', position: 1 },
			],
			members: [{ id: '7', roles: ['30'] }],
		})
		const port = guildPort(guild)
		await port.addRole('7', '20')
		await port.removeRole('7', '30')
		await port.addRole('8', '20') // not in the cache at all
		expect(calls.map((c) => c.method)).toEqual(['PUT', 'DELETE', 'PUT'])
		expect(calls.every((c) => c.body === undefined)).toBe(true)
	})

	it("passes Discord's error through, code included", async () => {
		const unknownMember = Object.assign(new Error('Unknown Member'), {
			code: 10007,
		})
		const { guild } = makeGuild({ failWith: unknownMember })
		const port = guildPort(guild)
		await expect(port.addRole('7', '20')).rejects.toMatchObject({ code: 10007 })
		await expect(port.removeRole('7', '20')).rejects.toMatchObject({
			code: 10007,
		})
	})

	it('lists every fetched member with their name and role ids', async () => {
		const { guild } = makeGuild({
			roles: [
				{ id: '20', position: 2 },
				{ id: '30', position: 1 },
			],
			members: [
				{ id: '7', roles: ['20', '30'] },
				{ id: '8', roles: [] },
			],
		})
		// A full member fetch goes over the gateway, which these tests don't
		// run; answer it with the members already built.
		guild.members.fetch = (async () => guild.members.cache) as never
		const listed = await guildPort(guild).listMembers()
		const byId = Object.fromEntries(listed.map((m) => [m.id, m]))
		expect(listed).toHaveLength(3)
		expect(byId['7']).toEqual({
			id: '7',
			name: 'user-7',
			roleIds: expect.arrayContaining(['20', '30']),
		})
		expect(byId['8'].name).toBe('user-8')
		expect(byId['8'].roleIds).not.toContain('20')
	})
})

describe('rolePlacementProblems', () => {
	const below = [
		{ id: '20', position: 2 },
		{ id: '30', position: 1 },
	]

	it('finds nothing when every role sits below the bot and it can manage roles', () => {
		const { guild } = makeGuild({ roles: below })
		expect(rolePlacementProblems(guild, { gold: '20', steel: '30' })).toEqual(
			[],
		)
	})

	it('accepts Administrator in place of Manage Roles', () => {
		const { guild } = makeGuild({
			roles: below,
			botPermissions: String(PermissionFlagsBits.Administrator),
		})
		expect(rolePlacementProblems(guild, { gold: '20' })).toEqual([])
	})

	it('names a missing Manage Roles permission', () => {
		const { guild } = makeGuild({
			roles: below,
			botPermissions: String(
				new PermissionsBitField(PermissionFlagsBits.SendMessages).bitfield,
			),
		})
		expect(rolePlacementProblems(guild, { gold: '20' })).toEqual([
			'the bot lacks the Manage Roles permission',
		])
	})

	it('names a role id that is not in the server', () => {
		const { guild } = makeGuild({ roles: below })
		expect(rolePlacementProblems(guild, { gold: '20', glass: '99' })).toEqual([
			'glass: role 99 is not in the server',
		])
	})

	it("names a role above the bot's highest role, and the bot's own role", () => {
		const { guild } = makeGuild({
			roles: [...below, { id: '60', position: 6 }],
		})
		expect(
			rolePlacementProblems(guild, {
				negative: '60',
				foil: BOT_ROLE,
				gold: '20',
			}),
		).toEqual([
			`negative: "role-60" is not below the bot's highest role "role-${BOT_ROLE}"`,
			`foil: "role-${BOT_ROLE}" is not below the bot's highest role "role-${BOT_ROLE}"`,
		])
	})

	it('names a role that belongs to an integration', () => {
		const { guild } = makeGuild({
			roles: [{ id: '40', position: 1, managed: true }],
		})
		expect(rolePlacementProblems(guild, { stone: '40' })).toEqual([
			'stone: "role-40" belongs to an integration and can\'t be assigned',
		])
	})

	it('says so when the bot is not in the server', () => {
		const { guild } = makeGuild({ roles: below, botMember: false })
		expect(rolePlacementProblems(guild, { gold: '20' })).toEqual([
			'the bot is not a member of the server',
		])
	})
})

describe('SYNC_COMMAND', () => {
	it('is /sync-ranks, for members who can manage roles, with no options', () => {
		const json = SYNC_COMMAND.toJSON()
		expect(json.name).toBe('sync-ranks')
		expect(json.default_member_permissions).toBe(MANAGE_ROLES)
		expect(json.options ?? []).toEqual([])
	})
})
