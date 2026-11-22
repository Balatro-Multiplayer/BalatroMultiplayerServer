// What a PvP mode implements. Every rule is a pure function that reads the run and names
// people or facts; none writes the run. The one exception is `onAnte`, which stores the
// pairing or the card targets the mode owns.
//
// Adding a mode: one file in modes/ that exports a `Mode`, registered in `pickMode`
// (modes/index.ts), the only place that maps a mode name to a Mode; add its name to
// `ModeName` here (and `PvpMode` in settings.ts, with its queue mode). The shared code
// never asks which mode it is: it reads the data fields and calls the rules.
// A mode only names losers and gainers; the life ledger (lives.ts) is the one writer
// of lives.
import type { Ending } from '../core/ending'
import type { PlayerId, PvpBlind, Run, Targets, Team } from '../core/types'
import type { VoucherBought } from '../rules/lives'
import type { PvpMode, PvpSettings } from '../rules/settings'

// A dead player whose result waits on the same-blind result of `waitingFor`.
export interface WaitingDeath {
	playerId: string
	blindKey: string
	waitingFor: string[]
}

// Nemesis: who fights whom at one ante. Stored, so a repeat or a death never
// re-pairs; the mode owns it.
export interface PvpPairing {
	ante: number
	// userId -> partner, null for the bye. A partner who dies stays in.
	partners: { [userId: string]: string | null }
	// "a|b" with the two ids sorted.
	usedPairs: string[]
	lastBye: string | null
}

// Teams: the opposing member each player's card targets at one ante. Random, so
// stored: a repeat never re-draws it; the mode owns it.
export interface PvpCardTargets {
	ante: number
	targets: { [userId: string]: string | null }
}

export type ModeName = 'duel' | PvpMode

// What the lobby knows when a run starts: the started ids in start order, the
// teams the players picked, and a matchmade team split.
export interface RunStart {
	startedIds: string[]
	picks: { [id: string]: Team }
	teamPlan: string[][] | null
}

// What a mode settles once, when a run starts.
interface RunOpening {
	lives: Run['lives']
	teams: { [id: string]: Team }
	teamLives: { A: number; B: number } | null
	cardTargets: PvpCardTargets | null
}

// What a mode says each player is up against. The view fills the rest with empty
// values: `cut` none (Royale only), `pairingAnte` null (Nemesis and Teams only).
export interface TargetsShown {
	opponents: { [id: string]: string | null }
	cut?: { [id: string]: Targets['cut'] }
	pairingAnte?: number | null
	// Teams: each player's card target.
	cardTargets?: { [id: string]: string | null }
}

// Who a player's card reaches, and the one opponent the player scores against.
export interface Opponents {
	each: PlayerId[]
	one: PlayerId | null
}

// Whose answer a player's last life lost on a normal blind waits on:
// - 'opponent': the one opponent;
// - 'everyone': every other player still in the run, a game of 3+;
// - 'side': the other side as a whole, Manhunt and Teams.
type DeathWaitsOn = 'opponent' | 'everyone' | 'side'

// Teams: one pool of lives per team. The charges and the waiting death stay the
// ledger's; a mode without a pool charges each player's own lives.
export interface LifePool {
	// The players that show the loss when `id` is charged: all of id's team. Empty
	// when nothing is charged (id on no team, or its pool already at 0).
	teamMemberIds: (run: Run, id: string) => string[]
	// One life off the pool of id's team, with the loss event under `cause`.
	takeLife: (run: Run, id: string, cause: string | null) => Run
	// Who is charged for a lost PvP blind, out of its `losers`: one per losing team.
	payers: (run: Run, losers: string[]) => string[]
}

export interface Mode {
	name: ModeName
	// The teams a player may pick before the run; a mode without picks leaves it out.
	pickableTeams?: Team[]
	// Who a death on a normal blind waits on.
	deathWaitsOn: DeathWaitsOn
	// 'side' deaths only: whether `id` running out of lives opens the waiting death
	// (default yes). Manhunt: only the Runner does, a Hunter at 0 is simply out.
	opensSideDeath?: (run: Run, id: string) => boolean
	// Whether the run pairs its players each ante: a player left with nobody in a paired
	// ante has a bye.
	pairs: 'by ante' | 'none'
	// The team's life pool (Teams only).
	lifePool?: LifePool
	// Settles the roster, the teams and the lives once, at the start of a run.
	init: (
		rules: PvpSettings,
		start: RunStart,
		random: () => number,
	) => RunOpening
	// The players who lose a life for `PvP blind`, or null while it is not decided: it is
	// decided once the players of the PvP blind have no hands left, as the mode says.
	losersOf: (run: Run, currentPvpBlind: PvpBlind) => PlayerId[] | null
	// A voucher action (Manhunt: a Runner's ante-skip voucher gives Hunters a life).
	// The mode names the gainers; only the ledger changes lives.
	voucherGainers?: (run: Run, action: VoucherBought) => string[]
	// Who may redeem a voucher; a mode without it refuses every voucher.
	// Whether `playerId` may redeem a voucher (a refused one gets `not_in_run`).
	mayRedeemVoucher?: (run: Run, playerId: string) => boolean
	// How the run ends, null while it goes on.
	checkWinner: (run: Run) => Ending | null
	// Ante rules (re-pairing, the Runner's ante 9): the run with what the mode stores for the
	// highest ante reported; the same run when there is nothing new.
	onAnte?: (run: Run, random: () => number) => Run
	// Who targets whom at `ante`, as the players may see it before any score is known.
	view: (run: Run, ante: number | null) => TargetsShown
	// Both team sums of the PvP blind, null with no team to sum (Teams only).
	teamScores?: (
		run: Run,
		currentPvpBlind: PvpBlind,
	) => { A: string | null; B: string | null }
	// The opponents of `actor` out of what `view` shows, before the shared checks (not
	// oneself, nobody out of the run, no teammate).
	pickOpponents: (run: Run, actor: PlayerId, shown: TargetsShown) => Opponents
}
