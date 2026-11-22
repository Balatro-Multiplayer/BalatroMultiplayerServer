// The settings a PvP game starts with, read from the host-written lobby metadata, and
// the checks on a blind key. Pure.
//
// The client always writes every key the rules freeze from (PVP.pvp_lobby_metadata),
// so a key that is missing or malformed is refused as bad_rules naming it; the server
// invents no default. The mode comes from queue_mode through the same flags as the
// client's PVP_GAMEMODES.

export type PvpMode = 'royale' | 'nemesis' | 'manhunt' | 'teams'

type SkipTimeRule = 'lead' | 'own'

// Who counts the Ante clock: a shared server bank, a personal clock per player
// (Pressure, Speedlatro), or nobody.
export type AnteClock = 'bank' | 'personal' | 'none'

// The PvP hand timer: the allowance at PvP blind open, and the time each hand adds.
interface PvpClockRules {
	baseMilliseconds: number
	handMilliseconds: number
}

// A personal clock's rules. `timedRate` is the rate while an Ante deadline times the
// player (outside PvP for Speedlatro).
type PersonalClockRules =
	| {
			kind: 'pressure'
			baseMilliseconds: number
			timedRate: 1 | 2
			previewCostMilliseconds: number
	  }
	| {
			kind: 'speedlatro'
			baseMilliseconds: number
			// The clock at the player's own blind start.
			pvpMilliseconds: number
			timedRate: 1 | 2
			previewCostMilliseconds: number
	  }

export interface ClockRules {
	ante: AnteClock
	pvp: PvpClockRules | null
	personal: PersonalClockRules | null
}

// The settings frozen when the caller sees a new runId.
export interface PvpSettings {
	mode: PvpMode
	startedCount: number
	startingLives: number
	hunterLives: number
	// The first ante whose Boss is the PvP blind (lobby metadata pvp_start_ante).
	pvpStartAnte: number
	clocks: ClockRules
	// The server-counted Ante timer's restart base and the run-outs forgiven per
	// game (lobby metadata timer_base_seconds, timer_forgiveness).
	timerBaseMilliseconds: number
	timerForgiveness: number
	// What the skip time adds to an Ante bank per skip of lead (null = none), and
	// whose skips count: 'lead' over the facing player, 'own' since the last PvP blind.
	timerIncrementMilliseconds: number | null
	skipTimeRule: SkipTimeRule
	// An Ante countdown is shown to the player it times only once its time left is at or
	// below this (null = always shown).
	timerDisplayThresholdMilliseconds: number | null
	// Lobby options death_on_normal_blind_loss and gold_on_life_loss: whether a failed blind costs
	// a life, and whether each life lost is paid as comeback gold.
	failedBlindLife: 'costs' | 'free'
	lifeLossGold: 'paid' | 'none'
}

// queue_mode -> mode. Small World differs only in client content, so it plays
// the Royale rules. A queue mode not listed (or missing) has no mode: null.
const MODE_OF_QUEUE: { [queueMode: string]: PvpMode } = {
	pvp_nemesis: 'nemesis',
	pvp_experimental: 'nemesis',
	pvp_manhunt: 'manhunt',
	pvp_teams: 'teams',
	pvp_royale: 'royale',
	pvp_smallworld: 'royale',
}

export function modeOfQueue(queueMode: unknown): PvpMode | null {
	if (typeof queueMode !== 'string') return null
	return Object.prototype.hasOwnProperty.call(MODE_OF_QUEUE, queueMode)
		? MODE_OF_QUEUE[queueMode]
		: null
}

// A positive whole number from a number or a numeric string; else null.
function positiveWholeNumber(value: unknown): number | null {
	const parsed =
		typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0
		? parsed
		: null
}

// "<ante>:<blind>", the key the client names a blind by.
// A negative, fractional or zero-padded ante is malformed: the request is a bad_payload
// (`02:Small` and `2:Small` would be two keys for one blind).
const BLIND_KEY = /^(0|[1-9]\d*):(Small|Big|Boss)$/

export function isBlindKey(value: unknown): value is string {
	return typeof value === 'string' && BLIND_KEY.test(value)
}

// The ante of a valid blindKey.
export const anteOfBlind = (blindKey: string): number =>
	Number(blindKey.split(':')[0])

// Ready is taken on any Boss blind: the ante cannot be checked here because a Manhunt
// voucher can lower it after the PvP Boss was set.
export function isBossBlind(blindKey: string): boolean {
	return blindKey.endsWith(':Boss')
}

// The timer bank a start may claim and the base a server-counted timer restarts
// from: 10 s to 60 min (the lobby's `timer_base_seconds` must lie in it).
export const MIN_TIMER_MILLISECONDS = 10_000
export const MAX_TIMER_MILLISECONDS = 3_600_000
export const MAX_TIMER_FORGIVENESS = 9
// The most lives a lobby may start with. The bound is the server's: the clients send
// 4 lives (core.lua defaults) and nothing above 10 is a sane duel.
export const MAX_STARTING_LIVES = 10

// A finite number from a number or a numeric string; else null.
function numberOrNull(value: unknown): number | null {
	const parsed =
		typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

// A finite number within [lowest, highest] from a number or a numeric string; else null.
function numberBetween(
	value: unknown,
	lowest: number,
	highest: number,
): number | null {
	const parsed = numberOrNull(value)
	return parsed !== null && parsed >= lowest && parsed <= highest
		? parsed
		: null
}

// A whole number within [lowest, highest] from a number or a numeric string; else null.
function wholeNumberBetween(
	value: unknown,
	lowest: number,
	highest: number,
): number | null {
	const parsed = numberBetween(value, lowest, highest)
	return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

// A private lobby's boolean option. Absent is on (the mod's default, core.lua); a present
// value that is not a boolean is malformed: null.
function lobbyOption(value: unknown): boolean | null {
	if (value === undefined) return true
	return typeof value === 'boolean' ? value : null
}

// The clock rules of every ruleset: the one table the Ante clock, the PvP hand timer
// and the personal clocks are read from. The host publishes the rolled ruleset to
// metadata.ruleset, never the layers. A ruleset not in the table has no clock rules:
// clockSettingOf reports bad_rules and the caller refuses the start.
const PRESSURE = {
	kind: 'pressure',
	baseMultiplier: 2,
	timedRate: 2,
	previewCostMilliseconds: 3500,
} as const
const SPEEDLATRO = {
	kind: 'speedlatro',
	baseMilliseconds: 147_000,
	pvpMilliseconds: 73_500,
	timedRate: 2,
	previewCostMilliseconds: 0,
} as const
const PVP_HAND_TIMER = {
	baseMilliseconds: 60_000,
	handMilliseconds: 10_000,
} as const

// `ownSkips`: every own skip since the last PvP blind adds the increment, not only the
// lead over the opponent. `forcedTimer`: a league ruleset forces the lobby's timers; the
// frozen settings read these numbers, never the host's.
interface ClockSetting {
	ante: AnteClock
	pvp: PvpClockRules | null
	personal: typeof PRESSURE | typeof SPEEDLATRO | null
	ownSkips: boolean
	forcedTimer: { baseSeconds: number; forgiveness: number } | null
	displayThresholdMilliseconds: number | null
}

// The clock setting of a ruleset that has only the Ante bank.
const BANK_ONLY: ClockSetting = {
	ante: 'bank',
	pvp: null,
	personal: null,
	ownSkips: false,
	forcedTimer: null,
	displayThresholdMilliseconds: null,
}

const BANK_ONLY_RULESETS = [
	'ruleset_mp_experimental_legacy',
	'ruleset_mp_badlatro',
	'ruleset_mp_legacy_ranked',
	'ruleset_mp_sandbox',
	'ruleset_mp_smallworld',
	'ruleset_mp_vanilla',
	'ruleset_mp_wsob',
]

const PVP_HAND_TIMER_ONLY: ClockSetting = { ...BANK_ONLY, pvp: PVP_HAND_TIMER }

const SPEEDLATRO_CLOCK: ClockSetting = {
	...BANK_ONLY,
	ante: 'personal',
	personal: SPEEDLATRO,
}

const CLOCK_EXCEPTIONS: { [ruleset: string]: ClockSetting } = {
	ruleset_mp_experimental: {
		ante: 'personal',
		pvp: PVP_HAND_TIMER,
		personal: PRESSURE,
		ownSkips: false,
		forcedTimer: null,
		displayThresholdMilliseconds: null,
	},
	ruleset_mp_balanced: PVP_HAND_TIMER_ONLY,
	ruleset_mp_expanded: PVP_HAND_TIMER_ONLY,
	// Almanac is Expanded plus the almanac layer.
	ruleset_mp_almanac: PVP_HAND_TIMER_ONLY,
	ruleset_mp_speedlatro: SPEEDLATRO_CLOCK,
	ruleset_mp_chaos: SPEEDLATRO_CLOCK,
	// rulesets/majorleague.lua:11-12 and minorleague.lua:7-8 in the PvP mod.
	ruleset_mp_majorleague: {
		...BANK_ONLY,
		ownSkips: true,
		forcedTimer: { baseSeconds: 180, forgiveness: 0 },
		// layers/majorleague.lua: timer_display_threshold = 180.
		displayThresholdMilliseconds: 180_000,
	},
	ruleset_mp_minorleague: {
		...BANK_ONLY,
		forcedTimer: { baseSeconds: 210, forgiveness: 1 },
	},
	ruleset_mp_traditional: { ...BANK_ONLY, ante: 'none' },
}

const RULESET_CLOCKS: { [ruleset: string]: ClockSetting } = {
	...Object.fromEntries(BANK_ONLY_RULESETS.map((id) => [id, BANK_ONLY])),
	...CLOCK_EXCEPTIONS,
}

type ClockSettingResult =
	| { ok: true; clock: ClockSetting }
	| { ok: false; reason: 'bad_rules' }

// The clock setting of a ruleset id; a missing or unknown id is bad_rules.
export function clockSettingOf(ruleset: unknown): ClockSettingResult {
	if (
		typeof ruleset !== 'string' ||
		!Object.prototype.hasOwnProperty.call(RULESET_CLOCKS, ruleset)
	)
		return { ok: false, reason: 'bad_rules' }
	return { ok: true, clock: RULESET_CLOCKS[ruleset] }
}

// The frozen clock rules of a game: the clock setting with the Pressure base resolved
// from the lobby's Ante base (`timerBaseMilliseconds`).
function clockRulesFor(
	setting: ClockSetting,
	timerBaseMilliseconds: number,
): ClockRules {
	const { ante, pvp, personal } = setting
	if (personal === null) return { ante, pvp, personal: null }
	if (personal.kind === 'speedlatro') return { ante, pvp, personal }
	return {
		ante,
		pvp,
		personal: {
			kind: 'pressure',
			baseMilliseconds: timerBaseMilliseconds * personal.baseMultiplier,
			timedRate: personal.timedRate,
			previewCostMilliseconds: personal.previewCostMilliseconds,
		},
	}
}

function secondsToMilliseconds(seconds: number | null): number | null {
	return seconds === null ? null : Math.max(0, Math.round(seconds * 1000))
}

// The lobby metadata keys the rules freeze from; a bad value is reported by key.
type RuleKey =
	| 'ruleset'
	| 'queue_mode'
	| 'starting_lives'
	| 'manhunt_hunter_lives'
	| 'pvp_start_ante'
	| 'timer_base_seconds'
	| 'timer_forgiveness'
	| 'timer_increment_seconds'
	| 'death_on_normal_blind_loss'
	| 'gold_on_life_loss'
	| 'timer'

type SettingsResult =
	| { ok: true; settings: PvpSettings }
	| { ok: false; reason: 'bad_rules'; key: string }

// The settings to freeze for a game started by `startedIds` (the caller adds the runId).
// A key that does not validate is a `bad_rules` result naming it; nothing
// is invented and nothing throws.
export function settingsFromLobby(
	lobbySettings: { [key: string]: unknown },
	startedIds: string[],
): SettingsResult {
	const found = clockSettingOf(lobbySettings.ruleset)
	if (!found.ok) return { ok: false, reason: 'bad_rules', key: 'ruleset' }
	const bad = (key: RuleKey): SettingsResult => ({
		ok: false,
		reason: 'bad_rules',
		key,
	})
	const mode = modeOfQueue(lobbySettings.queue_mode)
	if (mode === null) return bad('queue_mode')
	const startingLives = wholeNumberBetween(
		lobbySettings.starting_lives,
		1,
		MAX_STARTING_LIVES,
	)
	if (startingLives === null) return bad('starting_lives')
	const hunterLives = positiveWholeNumber(lobbySettings.manhunt_hunter_lives)
	if (hunterLives === null) return bad('manhunt_hunter_lives')
	const pvpStartAnte = positiveWholeNumber(lobbySettings.pvp_start_ante)
	if (pvpStartAnte === null) return bad('pvp_start_ante')
	// A league ruleset forces both timers, so its lobby needs to carry neither.
	const forced = found.clock.forcedTimer
	const baseSeconds = forced
		? forced.baseSeconds
		: numberBetween(
				lobbySettings.timer_base_seconds,
				MIN_TIMER_MILLISECONDS / 1000,
				MAX_TIMER_MILLISECONDS / 1000,
			)
	if (baseSeconds === null) return bad('timer_base_seconds')
	const forgiveness = forced
		? forced.forgiveness
		: wholeNumberBetween(
				lobbySettings.timer_forgiveness,
				0,
				MAX_TIMER_FORGIVENESS,
			)
	if (forgiveness === null) return bad('timer_forgiveness')
	// No skip time is an explicit null; a missing key is refused like every other.
	const rawIncrement = lobbySettings.timer_increment_seconds
	const increment = rawIncrement === null ? null : numberOrNull(rawIncrement)
	if (rawIncrement !== null && increment === null)
		return bad('timer_increment_seconds')
	const deathOnNormalBlindLoss = lobbyOption(lobbySettings.death_on_normal_blind_loss)
	if (deathOnNormalBlindLoss === null) return bad('death_on_normal_blind_loss')
	const goldOnLifeLoss = lobbyOption(lobbySettings.gold_on_life_loss)
	if (goldOnLifeLoss === null) return bad('gold_on_life_loss')
	const timerOption = lobbyOption(lobbySettings.timer)
	if (timerOption === null) return bad('timer')
	const timerBaseMilliseconds = Math.round(baseSeconds * 1000)
	return {
		ok: true,
		settings: {
			mode,
			startedCount: startedIds.length,
			startingLives,
			hunterLives,
			pvpStartAnte,
			// Timer off (the lobby toggle) stops the Ante bank, Pressure and the PvP hand
			// timer; the Speedlatro clock ignores it, as on main.
			clocks:
				timerOption || found.clock.personal?.kind === 'speedlatro'
					? clockRulesFor(found.clock, timerBaseMilliseconds)
					: { ante: 'none', pvp: null, personal: null },
			// The host publishes the raw values (timer_base_seconds is not multiplied).
			timerBaseMilliseconds,
			timerIncrementMilliseconds: secondsToMilliseconds(increment),
			skipTimeRule: found.clock.ownSkips ? 'own' : 'lead',
			timerDisplayThresholdMilliseconds:
				found.clock.displayThresholdMilliseconds,
			timerForgiveness: forgiveness,
			failedBlindLife: deathOnNormalBlindLoss ? 'costs' : 'free',
			lifeLossGold: goldOnLifeLoss ? 'paid' : 'none',
		},
	}
}
