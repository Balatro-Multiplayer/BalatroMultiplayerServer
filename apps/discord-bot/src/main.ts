import {
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	REST,
	Routes,
} from 'discord.js'
import { SYNC_COMMAND, guildPort, rolePlacementProblems } from './discord.js'
import { loadConfig } from './env.js'
import { LADDERS } from './ladders.js'
import { createStandingsClient } from './standings-client.js'
import { type SweepSummary, formatSummary, runSweep } from './sweep.js'

const loaded = loadConfig(process.env, LADDERS)
if (!loaded.ok) {
	// Not configured: stay off. Exit 0 so `restart: on-failure` leaves it off.
	console.error(`[discord-bot] disabled: ${loaded.problems.join('; ')}`)
	process.exit(0)
}
const config = loaded.config

// A slash-command reply must be sent within 15 minutes of the command.
const REPLY_WAIT_MS = 10 * 60_000

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
})
const fetchStandings = createStandingsClient(config.apiUrl, config.apiKey)

let running: Promise<SweepSummary> | null = null

// One sweep at a time: a call while one runs gets that sweep's result.
function sweep(trigger: string): Promise<SweepSummary> {
	if (running) return running
	running = (async () => {
		console.log(
			`[discord-bot] sweep started (${trigger})${config.dryRun ? ' [dry-run]' : ''}`,
		)
		const guild = await client.guilds.fetch(config.guildId)
		const summary = await runSweep({
			guild: guildPort(guild),
			fetchStandings,
			ladders: LADDERS,
			roleIds: config.roleIds,
			dryRun: config.dryRun,
		})
		console.log(`[discord-bot] sweep done: ${formatSummary(summary)}`)
		return summary
	})().finally(() => {
		running = null
	})
	return running
}

function scheduledSweep() {
	sweep('scheduled').catch((err) =>
		console.error(
			`[discord-bot] sweep failed, nothing changed: ${(err as Error)?.message ?? err}`,
		),
	)
}

client.once(Events.ClientReady, async (ready) => {
	try {
		const guild = await client.guilds.fetch(config.guildId)
		await guild.roles.fetch()
		await guild.members.fetchMe()
		for (const problem of rolePlacementProblems(guild, config.roleIds))
			console.warn(`[discord-bot] can't manage a role: ${problem}`)

		// POST creates or updates this one command and leaves any others alone.
		const rest = new REST().setToken(config.token)
		await rest.post(
			Routes.applicationGuildCommands(config.clientId, config.guildId),
			{ body: SYNC_COMMAND.toJSON() },
		)

		console.log(
			`[discord-bot] ready as ${ready.user.username} in ${guild.name}; sweeping every ${config.syncIntervalMs / 60_000} min${config.dryRun ? ' [dry-run]' : ''}`,
		)
	} catch (err) {
		console.error(
			`[discord-bot] startup failed: ${(err as Error)?.message ?? err}`,
		)
		process.exit(1)
	}
	scheduledSweep()
	setInterval(scheduledSweep, config.syncIntervalMs)
})

client.on(Events.InteractionCreate, async (interaction) => {
	if (
		!interaction.isChatInputCommand() ||
		interaction.commandName !== SYNC_COMMAND.name
	)
		return
	if (interaction.guildId !== config.guildId) return
	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral })
		const joined = running !== null
		const result = await Promise.race([
			sweep(`/sync-ranks by ${interaction.user.username}`),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), REPLY_WAIT_MS).unref(),
			),
		])
		const lead = joined
			? 'A sweep was already running; here is its result. '
			: ''
		await interaction.editReply(
			result
				? lead + formatSummary(result)
				: 'Still running (many roles to change). The summary will be in the bot logs.',
		)
	} catch (err) {
		console.error(
			`[discord-bot] /sync-ranks failed: ${(err as Error)?.message ?? err}`,
		)
		await interaction
			.editReply(
				`Sweep failed before changing anything: ${(err as Error)?.message ?? err}`,
			)
			.catch(() => {})
	}
})

client.on(Events.Error, (err) =>
	console.error('[discord-bot] client error:', err),
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void client.destroy().finally(() => process.exit(0))
	})
}

await client.login(config.token)
