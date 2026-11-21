import {
	type Guild,
	type GuildMember,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from 'discord.js'
import type { GuildMemberInfo, GuildPort } from './sweep.js'

const REASON = 'Rank role sync'

function memberInfo(m: GuildMember): GuildMemberInfo {
	return { id: m.id, name: m.user.username, roleIds: [...m.roles.cache.keys()] }
}

// Role changes go through GuildMemberManager.addRole/removeRole: one PUT or
// DELETE per role. GuildMemberRoleManager.add/remove with an ARRAY sends the
// member's whole role list from the cache (it calls set()), which is how
// Botlatro clobbered unrelated roles (its commit ea6a557), so never use those.
export function guildPort(guild: Guild): GuildPort {
	return {
		async listMembers() {
			return (await guild.members.fetch()).map(memberInfo)
		},
		// Kept current by the Server Members intent's member updates.
		cachedMembers() {
			return guild.members.cache.map(memberInfo)
		},
		async addRole(memberId, roleId) {
			await guild.members.addRole({
				user: memberId,
				role: roleId,
				reason: REASON,
			})
		},
		async removeRole(memberId, roleId) {
			await guild.members.removeRole({
				user: memberId,
				role: roleId,
				reason: REASON,
			})
		},
	}
}

/**
 * Problems that stop the bot from managing the roles, one line each: a
 * missing Manage Roles permission, a role id not in the server, or a role at
 * or above the bot's highest role (Discord refuses those with 50013).
 */
export function rolePlacementProblems(
	guild: Guild,
	roleIds: Record<string, string>,
): string[] {
	const me = guild.members.me
	if (!me) return ['the bot is not a member of the server']
	const problems: string[] = []
	if (!me.permissions.has(PermissionFlagsBits.ManageRoles))
		problems.push('the bot lacks the Manage Roles permission')
	for (const [name, id] of Object.entries(roleIds)) {
		const role = guild.roles.cache.get(id)
		if (!role) problems.push(`${name}: role ${id} is not in the server`)
		else if (role.managed)
			problems.push(
				`${name}: "${role.name}" belongs to an integration and can't be assigned`,
			)
		else if (me.roles.highest.comparePositionTo(role) <= 0)
			problems.push(
				`${name}: "${role.name}" is not below the bot's highest role "${me.roles.highest.name}"`,
			)
	}
	return problems
}

export const SYNC_COMMAND = new SlashCommandBuilder()
	.setName('sync-ranks')
	.setDescription('Sync everyone’s rank roles now')
	// Manage Roles: whoever can already hand out these roles by hand may ask
	// the bot to recompute them. Server admins can change this under Server
	// Settings > Integrations.
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
