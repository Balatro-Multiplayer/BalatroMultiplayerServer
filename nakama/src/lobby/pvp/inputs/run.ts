// A player's own run outside the PvP blind: the ante it reports, its blind results, skips,
// sells, shops and vouchers. This part is the only writer of those facts. Lives change only
// through the ledger (lives.ts), which every result and voucher goes through here.
import type { Handled, InputHandler } from '../core/apply'
import { changeRunPlayer } from '../core/run_player'
import { addInboxItem } from '../core/inbox'
import type {
	BlindKey,
	PlayerId,
	Run,
	RunPlayer,
	RunPlayerView,
	State,
} from '../core/types'
import { takeAction } from '../rules/lives'
import { opponentsOf, pairForNewAnte } from '../rules/opponent_targets'
import { isInRun, playedPvpBlind } from '../rules/players'
import { modeOf } from '../modes/index'
import { anteOfBlind } from '../rules/settings'
import { skipEntryOf, skipsReported } from '../rules/skips'
import { addSkipTime, startAtAnte } from './personal_clock'
import { BLIND_KEY_MAX, settlePvpBlind } from './pvp_blind'

export type RunActionInput =
	| { kind: 'progress'; ante: number; location: string }
	| {
			kind: 'blindResult'
			blindKey: BlindKey
			result: ClientBlindResult
	  }
	| { kind: 'skip'; blindKey: BlindKey; total: number }
	| { kind: 'sell'; ante: number; total: number }
	| { kind: 'shop'; ante: number; total: number; spent: number | null }
	| { kind: 'voucher'; voucherKey: string }

export const MAX_ANTE = 100
const LOCATION_MAX = 32
const VOUCHER_KEY_MAX = 64
const MAX_SELLS_PER_ANTE = 1000
export const MAX_SHOPS_PER_RUN = 160
export const MAX_SPENT = 1_000_000

const progressSpec = {
	ante: { type: 'whole', max: MAX_ANTE },
	location: { type: 'text', max: LOCATION_MAX },
} as const
// A skip is never reported here: it has its own input.
const CLIENT_BLIND_RESULTS = ['beaten', 'failed on the clock', 'lost'] as const
type ClientBlindResult = (typeof CLIENT_BLIND_RESULTS)[number]
const blindResultSpec = {
	blindKey: { type: 'text', max: BLIND_KEY_MAX },
	result: { type: 'oneOf', values: CLIENT_BLIND_RESULTS },
} as const
const skipSpec = {
	blindKey: { type: 'text', max: BLIND_KEY_MAX },
	total: { type: 'whole', max: 2 * (MAX_ANTE + 2) },
} as const
const sellSpec = {
	ante: { type: 'whole', max: MAX_ANTE },
	total: { type: 'whole', max: MAX_SELLS_PER_ANTE },
} as const
const shopSpec = {
	ante: { type: 'whole', max: MAX_ANTE },
	total: { type: 'whole', max: MAX_SHOPS_PER_RUN },
	spent: { type: 'whole', max: MAX_SPENT, nullable: true },
} as const
const voucherSpec = {
	voucherKey: { type: 'text', max: VOUCHER_KEY_MAX },
} as const

// The player's entry, or null when the state has no run or the player is not in it.
function entryOf(
	state: State,
	player: PlayerId,
): { run: Run; entry: RunPlayer } | null {
	const run = state.run
	const entry = run?.players[player]
	return run === null || entry === undefined ? null : { run, entry }
}

// A player may report only up to the ante it has reported. A player that reported none is
// at the first ante (a lost first report must not refuse the first blind).
function aheadOfProgress(entry: RunPlayer, ante: number): string | null {
	if (entry.ante === null) return ante > 1 ? 'no_progress' : null
	return ante > entry.ante ? 'ahead_of_progress' : null
}

export const progressHandler: InputHandler<typeof progressSpec> = {
	spec: progressSpec,
	handle(state, player, body, now) {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		const { entry } = found
		const rose = entry.ante === null || body.ante > entry.ante
		const written = changeRunPlayer(state, player, (own) => ({
			...own,
			ante: rose ? body.ante : own.ante,
			location: body.location,
		}))
		if (!rose) return written
		return startAtAnte(
			settlePvpBlind(
				pairForNewAnte(
					takeAction(written, { type: 'progress', playerId: player }),
				),
				now,
			),
			player,
			entry.ante === null,
			now,
		)
	},
}

// The one place a player's answer to a blind is written; a waiting death reads it.
function recordBlindResult(
	state: State,
	player: PlayerId,
	blindKey: BlindKey,
	result: RunPlayer['results'][string],
): State {
	return changeRunPlayer(state, player, (own) => ({
		...own,
		results: { ...own.results, [blindKey]: result },
	}))
}

export const blindResultHandler: InputHandler<typeof blindResultSpec> = {
	spec: blindResultSpec,
	handle(state, player, body) {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		if (playedPvpBlind(found.run, player, body.blindKey))
			return { refusal: 'pvp_blind' }
		const ahead = aheadOfProgress(found.entry, anteOfBlind(body.blindKey))
		if (ahead !== null) return { refusal: ahead }
		if (found.entry.results[body.blindKey] !== undefined) return state
		const { result } = body
		const recorded = recordBlindResult(state, player, body.blindKey, {
			result,
		})
		return takeAction(recorded, {
			type: 'blind',
			playerId: player,
			blindKey: body.blindKey,
			result,
		})
	},
}

export const skipHandler: InputHandler<typeof skipSpec> = {
	spec: skipSpec,
	handle(state, player, body) {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		if (!isInRun(found.run, player)) return { refusal: 'eliminated' }
		const ante = anteOfBlind(body.blindKey)
		const ahead = aheadOfProgress(found.entry, ante)
		if (ahead !== null) return { refusal: ahead }
		const counted: State = {
			...state,
			run: {
				...found.run,
				skips: skipsReported(found.run.skips, player, body.total),
			},
		}
		// Under the personal clock an opponent's skip gives each opponent clock time.
		const increment = found.run.rules.timerIncrementMilliseconds
		const gained = body.total - skipEntryOf(found.run.skips, player).skips
		const timed =
			increment === null || gained <= 0
				? counted
				: opponentsOf(counted, player).each.reduce(
						(next, opponent) => addSkipTime(next, opponent, gained * increment),
						counted,
					)
		// A skipped blind passes a death waiting on it; no life is touched.
		return found.entry.results[body.blindKey] === undefined
			? recordBlindResult(timed, player, body.blindKey, { result: 'skipped' })
			: timed
	},
}

export const sellHandler: InputHandler<typeof sellSpec> = {
	spec: sellSpec,
	handle(state, player, body) {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		const ahead = aheadOfProgress(found.entry, body.ante)
		if (ahead !== null) return { refusal: ahead }
		return changeRunPlayer(state, player, (own) => ({
			...own,
			sells: { ...own.sells, [String(body.ante)]: body.total },
		}))
	},
}

// The shop's dollars are only stored; the game pays Penny Pincher at its own cash-out.
// A skipped shop (no spend sent) is 0 dollars. The first total for a shop stands.
export const shopHandler: InputHandler<typeof shopSpec> = {
	spec: shopSpec,
	handle(state, player, body) {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		if (!isInRun(found.run, player)) return { refusal: 'eliminated' }
		const ahead = aheadOfProgress(found.entry, body.ante)
		if (ahead !== null) return { refusal: ahead }
		const shop = String(body.total)
		if (found.entry.shopSpends[shop] !== undefined) return state
		return changeRunPlayer(state, player, (own) => ({
			...own,
			shopSpends: { ...own.shopSpends, [shop]: body.spent ?? 0 },
		}))
	},
}

export const voucherHandler: InputHandler<typeof voucherSpec> = {
	spec: voucherSpec,
	handle(state, player, body): Handled {
		const found = entryOf(state, player)
		if (found === null) return { refusal: 'no_run' }
		const mode = modeOf(found.run)
		if (!mode.mayRedeemVoucher?.(found.run, player))
			return { refusal: 'not_in_run' }
		if (found.entry.vouchers.includes(body.voucherKey))
			return { refusal: 'already_redeemed' }
		const recorded = changeRunPlayer(state, player, (own) => ({
			...own,
			vouchers: [...own.vouchers, body.voucherKey],
		}))
		const gained = takeAction(recorded, {
			type: 'voucher',
			playerId: player,
			voucherKey: body.voucherKey,
		})
		const before = found.run.lives
		return Object.keys(gained.run?.lives ?? {})
			.sort()
			.filter((id) => (gained.run?.lives[id].lives ?? 0) > before[id].lives)
			.reduce(
				(next, hunter) =>
					addInboxItem(next, hunter, {
						from: player,
						effect: 'voucherLife',
						amount: 1,
					}),
				gained,
			)
	},
}

// What every player may see of another's run: copied as reported, never computed.
export function runPlayerView(run: Run, player: PlayerId): RunPlayerView {
	const entry = run.players[player]
	return {
		lives: run.lives[player].lives,
		ante: entry.ante,
		location: entry.location,
		skips: skipEntryOf(run.skips, player).skips,
		sells: { ...entry.sells },
		shopSpends: Array.from(
			{ length: Math.max(0, ...Object.keys(entry.shopSpends).map(Number)) },
			(_, place) => entry.shopSpends[String(place + 1)] ?? null,
		),
	}
}
