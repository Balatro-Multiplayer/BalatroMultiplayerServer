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
import { STARTUP_RETRY_MS, closeCodeProblem, setupProblem } from './startup.js'
import { type SweepSummary, formatSummary, runSweep } from './sweep.js'

// Registered first: as PID 1 in a container, Node ignores SIGTERM unless it
// has a handler, and `docker stop` would wait for its timeout.
let shutdown: () => Promise<unknown> = async () => {}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		void shutdown().finally(() => process.exit(0))
	})
}

let disabled = false

// For a mistake a restart can't fix (startup.ts): log it once, then do
// nothing until stopped. Compose restarts the bot whenever it exits, so
// exiting would log in to Discord again and again.
function stayDisabled(reason: string): Promise<never> {
	if (!disabled) {
		disabled = true
		console.error(
			`[discord-bot] disabled: ${reason}. Fix it, then restart the bot.`,
		)
		setInterval(() => {}, 2 ** 31 - 1) // keeps the process alive
	}
	return new Promise<never>(() => {})
}

const loaded = loadConfig(process.env, LADDERS)
const config = loaded.ok
	? loaded.config
	: await stayDisabled(loaded.problems.join('; '))

// A slash-command reply must be sent within 15 minutes of the command.
const REPLY_WAIT_MS = 10 * 60_000

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
})
shutdown = () => client.destroy()
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
	if (disabled) return // the client is destroyed; see stayDisabled
	sweep('scheduled').catch((err) =>
		console.error(
			`[discord-bot] sweep failed, nothing changed: ${(err as Error)?.message ?? err}`,
		),
	)
}

// A setup mistake leaves the bot disabled (stayDisabled). Anything else (a
// network blip, Discord down) exits 1 after a pause, and compose restarts it.
function afterStartupError(err: unknown): void {
	const message = (err as Error)?.message ?? String(err)
	void client.destroy()
	const problem = setupProblem(err)
	if (problem) {
		void stayDisabled(`${problem} (${message})`)
		return
	}
	if (disabled) return
	console.error(
		`[discord-bot] startup failed: ${message}. Restarting in ${STARTUP_RETRY_MS / 60_000} min.`,
	)
	setTimeout(() => process.exit(1), STARTUP_RETRY_MS)
}

// discord.js stops reconnecting after these close codes but doesn't fail
// login, so without this the bot would sit there doing nothing, silently.
client.on(Events.ShardDisconnect, (event) => {
	const problem = closeCodeProblem(event.code)
	if (!problem) return
	void client.destroy()
	void stayDisabled(`${problem} (gateway close ${event.code})`)
})

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
		afterStartupError(err)
		return
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

await client.login(config.token).catch(afterStartupError)
