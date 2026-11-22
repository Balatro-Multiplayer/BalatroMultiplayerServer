import type { PvpCardTargets, PvpPairing, WaitingDeath } from '../modes/types'
import type { EntryInput } from '../inputs/entry'
import type { FinishInput } from '../inputs/finish'
import type { PvpBlindInput } from '../inputs/pvp_blind'
import type { RunActionInput } from '../inputs/run'
import type { TimerInput } from '../inputs/timer'
// The state of a PvP match and the two shapes that cross the wire: what a player sends
// (an input) and what the server sends back (the view). Types only.
//
// Each kind of input is declared next to the code that handles it; the `Input` union
// gets a member in that part's change. A time field holds a server time, and its name
// ends in `At`: shiftTimes (clock.ts) moves exactly those.
import type { PvpLifePlayer } from '../rules/lives'
import type { PvpMode, PvpSettings } from '../rules/settings'
import type { SkipEntries } from '../rules/skips'

export type PlayerId = string
// A whole number of milliseconds on the server clock.
export type Milliseconds = number
// Why a player is away: their connection dropped, or the server restarted under them.
export type AwayReason = 'dropped' | 'server restart'
// When and why a player became away, as the lobby saw it.
export interface AwayFrom {
	since: Milliseconds
	reason: AwayReason
}
// Score text, parsed only by score.ts.
export type BigNum = string
// "<ante>:Small|Big|Boss"
export type BlindKey = string
export type Team = 'A' | 'B' | 'RUNNER' | 'HUNTER'

export interface PvpLimits {
	animatingHoldMilliseconds: number
	animatingBlindMilliseconds: number
	awayBudgetMilliseconds: number
}

// The rules frozen when a run starts: the settings value, plus the limits. The run id is
// `Run.id` only.
export type RunRulesAndLimits = PvpSettings & { limits: PvpLimits }

// ---- State ----

interface InboxItemBase {
	itemNumber: number
	from: PlayerId | null
	amount: number
}

// One shape per effect; a field exists only on the effect that carries it.
export type InboxItem = InboxItemBase & {
	effect: 'comebackBonus' | 'voucherLife'
}

// An item before it gets its number.
export type NewInboxItem = InboxItem extends infer Item
	? Item extends InboxItem
		? Omit<Item, 'itemNumber'>
		: never
	: never

// How a blind ended for a player: 'lost' is a PvP blind failed on the cards, 'failed on the
// clock' a blind failed any other way, 'skipped' a blind never played.
export type BlindResult = 'beaten' | 'failed on the clock' | 'lost' | 'skipped'

// What the player's game last reported of its own run (inputs/run.ts).
interface RunFacts {
	ante: number | null
	location: string | null
	// Cards sold, per ante.
	sells: { [ante: string]: number }
	// The whole dollars spent in each closed shop, by its number this run; 0 for a skipped shop.
	shopSpends: { [shopNumber: string]: number }
	// The first result reported for each blind.
	results: { [blindKey: string]: { result: BlindResult } }
	vouchers: string[]
}

export interface RunPlayer extends RunFacts {
	inbox: InboxItem[]
	// The newest item this player's game says it has done; 0 = none.
	inboxDone: number
	// The highest total seen per key (totalKey in apply.ts).
	totals: { [key: string]: number }
}

export interface Deadline {
	kind: 'ante' | 'pvp' | 'grace' | 'personal'
	// Who started it; null = the server.
	by: PlayerId | null
	against: PlayerId[]
	endsAt: Milliseconds
	pausedAt: Milliseconds | null
	// Why it is or is not counting (CountdownState); "held for player" resumes on its own.
	hold: CountdownState['kind']
	// How fast a personal countdown runs now: 1, or the timed rate while an Ante countdown
	// times its player. Only a personal countdown has one.
	rate?: 1 | 2
}

// Why a countdown is or is not counting:
// - counting: running.
// - paused by starter: its starter stopped it (timerPause), keeping the time left.
// - paused until timed: a personal countdown stopped by Ready, until an Ante countdown times
//   its player again or the PvP blind opens.
// - paused for pvp blind: stopped while the PvP blind plays.
// - paused for ready: an Ante countdown split off against one player who is Ready, frozen with
//   the time left; `after` is the state it returns to when they are not Ready any more.
// - held for player: an away or animating player pauses every countdown; it resumes on its own
//   when they stop.
export type CountdownState =
	| { kind: 'counting' }
	| { kind: 'paused by starter'; sinceAt: Milliseconds }
	| { kind: 'paused until timed'; sinceAt: Milliseconds }
	| { kind: 'paused for pvp blind'; sinceAt: Milliseconds }
	| {
			kind: 'paused for ready'
			sinceAt: Milliseconds
			// What it returns to when the player is not Ready any more: the starter's timer
			// runs, or the starter has stopped it.
			after: 'counting' | 'paused by starter'
	  }
	| { kind: 'held for player'; sinceAt: Milliseconds }

interface CountdownBase
	extends Omit<Deadline, 'kind' | 'pausedAt' | 'hold' | 'rate'> {
	hold: CountdownState
}

// A countdown the server keeps; the grace is the lobby's, never in a PvP run's clocks.
// An 'ante' countdown carries the Boss it presses for; it is not on the wire.
export type Countdown =
	| (CountdownBase & { kind: 'ante'; blindKey: BlindKey })
	| (CountdownBase & { kind: 'pvp' })
	| (CountdownBase & { kind: 'personal'; rate: 1 | 2 })

// A player who pauses the countdowns: away (its budget is the player's own) or animating
// (one hold, with what is left of it).
export type PlayerPause =
	| { player: PlayerId; reason: 'away' }
	| { player: PlayerId; reason: 'server restart' }
	| { player: PlayerId; reason: 'animating'; holdLeftMilliseconds: number }

export interface PlayerClock {
	awayLeftMilliseconds: number
	animatingBlindLeftMilliseconds: number
}

export interface Clocks {
	countdowns: Countdown[]
	playerPauses: PlayerPause[]
	players: { [player: PlayerId]: PlayerClock }
	// The pauses' budgets are charged up to here.
	settledAt: Milliseconds
}

export type EndedBy = 'hands' | 'timer'

// One player's place in the PvP blind being played. Only `endPvpBlindFor` writes `done`; a player
// done before entering the blind has no hands or score.
export type PvpBlindPlayer =
	| { stage: 'not entered' }
	// 'scoring a hand': Play was pressed (handsLeft is after it), its score has not come yet.
	| {
			stage: 'entered' | 'scoring a hand' | 'played a hand'
			handsLeft: number
			score: BigNum
	  }
	| {
			stage: 'done'
			endedBy: EndedBy
			handsLeft: number | null
			score: BigNum | null
	  }

// The PvP blind being played; its players are the ones it needed when it started. A PvP blind
// that is still waiting for Ready is never stored: see `pvpBlindToOpen`.
export interface PvpBlind {
	blindKey: BlindKey
	players: { [player: PlayerId]: PvpBlindPlayer }
	// Each player's PvP time bank while the run has the PvP timer, else empty: what a new PvP
	// countdown against them starts with. A counting one holds the time instead; pausing or
	// stopping it writes the time left back here.
	banks: { [player: PlayerId]: Milliseconds }
}

// The lives ledger's own records (lives.ts writes them).
export interface LifeLedger {
	lifeTakenFor: { [player: PlayerId]: string[] }
	runOutsForgiven: { [player: PlayerId]: number }
}

// One player leaving the standing: lives gone, forfeit, leave. Players going out in the same
// change share a `batch`, counted from 1. `blindKey` is the blind the last life was lost on,
// null for any other way out. The places of a 3+ game read both.
export interface RunExit {
	player: PlayerId
	blindKey: BlindKey | null
	batch: number
}

export interface Run {
	id: string
	rules: RunRulesAndLimits
	players: { [player: PlayerId]: RunPlayer }
	clocks: Clocks
	// The PvP blind being played; null otherwise.
	currentPvpBlind: PvpBlind | null
	// The Boss each player pressed Ready for; absent = not Ready. Writers: readyHandler (set and
	// clear) and the PvP blind's start (clears the players it takes in).
	ready: { [player: PlayerId]: BlindKey }
	// The players who pressed Ready first for their Boss, kept through an un-ready and cleared
	// when that PvP blind closes: on a level score the one listed is ahead. Writers: readyHandler
	// and settlePvpBlind.
	firstReady: PlayerId[]
	// Every resolved PvP blind, oldest first.
	finishedPvpBlinds: PvpBlindResult[]
	lives: { [player: PlayerId]: PvpLifePlayer }
	teamLives: { A: number; B: number } | null
	waitingDeaths: WaitingDeath[]
	// Every player's way out of the standing, oldest first (rules/deaths.ts writes it).
	exits: RunExit[]
	lifeLedger: LifeLedger
	// Who plays whom, one pairing per ante, made once and never replaced; the modes own
	// both (opponent_targets.ts). Antes nobody has reached have no entry.
	pairings: { [ante: number]: PvpPairing }
	cardTargets: PvpCardTargets | null
	// The team of each player, fixed when the run starts; empty in a mode without teams.
	teams: { [player: PlayerId]: Team }
	// Each player's reported skips: the one owner of the skip count (skips.ts).
	skips: SkipEntries
	// Who says yes to a draw or a new seed; a vote belongs to its run.
	votes: { draw: PlayerId[]; seed: PlayerId[] }
	// The place of each player once a win or draw is decided; 1 is first.
	places: { [player: PlayerId]: number }
	// What each finished player sent (inputs/finish.ts).
	endGames: { [player: PlayerId]: EndGame }
	// The newest jokers each player sent on leaving a shop (inputs/finish.ts), as text; an endGame replaces them.
	lastJokers: { [player: PlayerId]: string }
}

interface MatchPlayer {
	// Picked before the run; null = none picked.
	team: Team | null
}

export interface State {
	// The mode the lobby is set to, which decides the teams a player may pick before the
	// run. The run's own mode is frozen in `run.rules.mode`.
	lobbyMode: PvpMode
	players: { [player: PlayerId]: MatchPlayer }
	// null until the run starts.
	run: Run | null
	// null while the match is undecided; written only by `setResult` (inputs/finish.ts). It
	// stays on the match, not the run, because a leave before the run decides it; a
	// restart with a new seed must clear it.
	result: MatchResult | null
}

// ---- Input ----

interface InputHeader {
	messageNumber: number
	inboxDone: number
	// The run this input belongs to; null only for `team`.
	runId: string | null
}

// Header only: it says nothing but its inboxDone.
interface Applied {
	kind: 'applied'
}

export type Input = InputHeader &
	(
		| Applied
		| EntryInput
		| PvpBlindInput
		| RunActionInput
		| TimerInput
		| FinishInput
	)

// What an input did: the new state, and the refusal codes to log. A refusal changes
// nothing and is never sent to a player.
export interface InputResult {
	state: State
	refusals: string[]
}

// ---- View ----

interface EndStats {
	rerollCount: number
	rerollCostTotal: number
}

// How the match ended. One shape per kind, made only by the makers in inputs/finish.ts.
export type Rating = 'rated' | 'unrated'

export type MatchResult =
	| { kind: 'win'; winners: PlayerId[]; rating: Rating }
	| { kind: 'draw'; rating: Rating }
	| { kind: 'agreed' }
	| { kind: 'abandoned' }
	| { kind: 'contested' }
	| { kind: 'restarted' }

// What a player sent when they were done with the run.
export interface EndGame {
	jokers: string
	deck: string
	stats: EndStats
}

export interface RunPlayerView {
	lives: number
	ante: number | null
	location: string | null
	// Blinds skipped this run; a run starts at 0.
	skips: number
	sells: { [ante: string]: number }
	// The whole dollars spent in each shop, shop 1 first; null for a shop with no total.
	shopSpends: (number | null)[]
}

// Another player's score is hidden until the viewer has played a hand or finished.
export type ScoreView =
	| { kind: 'shown'; score: BigNum }
	| { kind: 'hidden' }
	| { kind: 'none yet' }

type PvpBlindPlayerView =
	| { stage: 'not entered' }
	| {
			stage: 'entered' | 'scoring a hand' | 'played a hand'
			handsLeft: number
			score: ScoreView
	  }
	| {
			stage: 'done'
			endedBy: EndedBy
			handsLeft: number | null
			score: ScoreView
	  }

export type PvpBlindView =
	| {
			stage: 'waiting'
			blindKey: BlindKey
			players: { [player: PlayerId]: 'ready' | 'not ready' }
	  }
	| {
			stage: 'playing'
			blindKey: BlindKey
			players: { [player: PlayerId]: PvpBlindPlayerView }
	  }

export interface PvpBlindResult {
	blindKey: BlindKey
	scores: { [player: PlayerId]: BigNum | null }
	endedBy: { [player: PlayerId]: EndedBy }
	losers: PlayerId[]
	livesAfter: { [player: PlayerId]: number }
	// Both team sums of the closed PvP blind (Teams); null in every other mode.
	teamScores: { A: BigNum | null; B: BigNum | null } | null
}

// The viewer's own Boss, the one on the ante they reported: 'plays', or 'bye' (in the PvP blind,
// compared with no one).
export type MyBoss = 'no pvp this ante' | 'plays' | 'bye'

export interface Targets {
	// The ante the pairing is for; null while nobody is paired.
	pairingAnte: number | null
	opponents: PlayerId[]
	cardTargets: PlayerId[]
	myBoss: MyBoss
	// Royale with 3 or more: where the viewer stands against the cut.
	cut: 'above the cut' | 'below the cut' | 'no cut'
	teamScores: { A: BigNum; B: BigNum } | null
}

// The mode rule files call `player` as `playerId`; the view says `player`.
interface WaitingDeathView {
	player: PlayerId
	blindKey: BlindKey
	waitingFor: PlayerId[]
}

export interface RunView {
	id: string
	rules: RunRulesAndLimits
	players: { [player: PlayerId]: RunPlayerView }
	currentPvpBlind: PvpBlindView | null
	finishedPvpBlinds: PvpBlindResult[]
	targets: Targets
	waitingDeaths: WaitingDeathView[]
	teamLives: { A: number; B: number } | null
	votes: { draw: PlayerId[]; seed: PlayerId[] }
}

// The result as the game reads it: the same kinds, and a win or draw says `rated` as a boolean.
export type MatchResultView =
	| { kind: 'win'; winners: PlayerId[]; rated: boolean }
	| { kind: 'draw'; rated: boolean }
	| Exclude<MatchResult, { kind: 'win' | 'draw' }>

// What the lobby stage shows: who is Ready, and the answer to this player's last Start.
export interface LobbyStageView {
	ready: { [player: PlayerId]: boolean }
	// Seated players whose connection is away now.
	away: PlayerId[]
	start: { number: number; refused: string | null } | null
}

export interface MatchView {
	stage: 'lobby' | 'setup' | 'run' | 'ended'
	result: MatchResultView | null
	run: RunView | null
	// Only in the lobby stage.
	lobby?: LobbyStageView
	// Only in the lobby stage: this player's view of the game that ended, until the next one starts.
	ended?: MyView
}

export interface PlayerView {
	team: Team | null
	status: 'playing' | 'away' | 'out' | 'left'
	place?: number
	endGame?: EndGame
	// The newest jokers they sent, for a viewer who is out or whose match has ended; absent once their endGame is shown.
	jokers?: string
}

export interface Pause {
	reason: 'away' | 'animating'
	players: PlayerId[]
	endsAt: Milliseconds
}

export interface TimersView {
	// Which timer the viewer may start now: the Ante timer while a Boss waits, the PvP timer
	// while a PvP blind plays; never both. 'someone away': it could start but a player is away,
	// and no timer starts then.
	timerButton: 'none' | 'ante' | 'pvp' | 'someone away'
	deadlines: Deadline[]
	pauses: Pause[]
	// Every player's PvP time bank in the PvP blind being played; empty outside one.
	pvpBanks: { [player: PlayerId]: Milliseconds }
	// Every player's Ante bank in ms: the time an Ante countdown against them starts with.
	anteBanks: { [player: PlayerId]: Milliseconds }
}

export interface MineView {
	inbox: InboxItem[]
	inboxNewest: number
}

export interface MyView {
	serverTime: Milliseconds
	lastMessageReceived: number
	me: PlayerId
	match: MatchView
	players: { [player: PlayerId]: PlayerView }
	timers: TimersView
	onlyMine: MineView
}
