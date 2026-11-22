// The life ledger of a PvP match: the one writer of every life change. Actions are applied
// here; a loss of the last life opens a waiting death (rules/deaths.ts). Mode rules only
// name losers and gainers; they never change a life.
//
// Pure. Every change takes a run and returns the run; the ledger's own records
// (`run.lifeLedger`) ride on it.
import { addInboxItem } from '../core/inbox'
import type { LifeLedger, Run, State } from '../core/types'
import type { LifePool, Mode } from '../modes/types'
import { openWaitingDeath, recordExits } from './deaths'
import { inRunIgnoringLives, isPvpBlindOf } from './players'
import { modeOf } from '../modes/index'

interface PvpLifeEvent {
	delta: number
	// The blindKey, "pvp:<n>" for a PvP loss, null for a gain.
	cause: string | null
}

// 'out': lost the last life. 'forfeited' and 'left' stay until the run ends.
type LifeStatus = 'playing' | 'out' | 'forfeited' | 'left'

export interface PvpLifePlayer {
	lives: number
	status: LifeStatus
	events: PvpLifeEvent[]
}

// The status once the lives are `lives`: a forfeit or a leave is never undone by a life change.
export function statusAfterLives(
	status: LifeStatus,
	lives: number,
): LifeStatus {
	if (status === 'forfeited' || status === 'left') return status
	return lives <= 0 ? 'out' : 'playing'
}

// An action the ledger reads.
export type PlayerAction =
	| {
			type: 'blind'
			playerId: string
			blindKey: string
			result: 'beaten' | 'failed on the clock' | 'lost' | 'skipped'
	  }
	| { type: 'voucher'; playerId: string; voucherKey: string }
	| { type: 'forfeit'; playerId: string }
	| { type: 'progress'; playerId: string }

// A Manhunt voucher action: the player who bought it and which one.
export interface VoucherBought {
	playerId: string
	voucherKey: string
}

function withPlayerLives(
	run: Run,
	id: string,
	playerLives: PvpLifePlayer,
): Run {
	return { ...run, lives: { ...run.lives, [id]: playerLives } }
}

function withLedger(run: Run, changes: Partial<LifeLedger>): Run {
	return { ...run, lifeLedger: { ...run.lifeLedger, ...changes } }
}

// Why a life is lost. A loss is charged once per (player, blind), so failing the blind a
// PvP blind was lost on costs nothing more; a timer run-out has no blind, always costs
// and leaves the charge alone.
export type LifeCause =
	| { kind: 'blind'; blindKey: string }
	| { kind: 'pvp_blind'; number: number; blindKey: string }
	| { kind: 'timer_ran_out' }

// The cause as the life event stores it: the blindKey, "pvp:<n>", or null.
function eventCause(cause: LifeCause): string | null {
	if (cause.kind === 'blind') return cause.blindKey
	if (cause.kind === 'pvp_blind') return `pvp:${cause.number}`
	return null
}

// The blind the loss is charged on.
function chargedBlindOf(cause: LifeCause): string | null {
	return cause.kind === 'timer_ran_out' ? null : cause.blindKey
}

// The one writer of a life loss. The last life on a non-PvP blind opens a waiting death.
function loseLife(run: Run, mode: Mode, id: string, lifeCause: LifeCause): Run {
	const cause = eventCause(lifeCause)
	const chargedBlind = chargedBlindOf(lifeCause)
	const playerLives = run.lives[id]
	if (
		!playerLives ||
		playerLives.lives <= 0 ||
		!inRunIgnoringLives(playerLives)
	)
		return run
	const chargedBlinds = run.lifeLedger.lifeTakenFor[id] ?? []
	// Each PvP blind is its own loss (`pvp:<n>`): only a life already taken on the blind blocks it.
	const lostPvpBlind = lifeCause.kind === 'pvp_blind'
	if (
		chargedBlind !== null &&
		chargedBlinds.includes(chargedBlind) &&
		(!lostPvpBlind || playerLives.events.some((e) => e.cause === chargedBlind))
	)
		return run

	const lives = playerLives.lives - 1
	let next = withPlayerLives(run, id, {
		...playerLives,
		lives,
		status: statusAfterLives(playerLives.status, lives),
		events: [...playerLives.events, { delta: -1, cause }],
	})
	if (chargedBlind !== null && !chargedBlinds.includes(chargedBlind))
		next = withLedger(next, {
			lifeTakenFor: {
				...run.lifeLedger.lifeTakenFor,
				[id]: [...chargedBlinds, chargedBlind],
			},
		})
	return lives <= 0 ? openWaitingDeath(next, mode, id, cause) : next
}

// A pooled game (Teams): a team's charge is spent by its first non-PvP
// blind failure and re-armed by the next progress of any member, so two teammates
// failing before anyone moves on cost the pool one life, and a failure after a member
// moved on costs another. `id` is the player whose loss it is (a waiting death opens
// on them); the mode's `lifePool` says who shares it. The spent charge is one
// `team:charged` entry in each member's `lifeTakenFor` list. A lost PvP blind is
// charged on the whole team; a failure of the PvP blind before that loss is the
// player's own, charged like loseLife's, and failures after the loss cost nothing in
// any order. A pool at 0 costs nothing. There is deliberately no `inRunIgnoringLives`
// check: a team loses the life whether or not the charged player is still in.
const TEAM_ALREADY_CHARGED = 'team:charged'

// A member's progress resets the team charge of every teammate.
function resetTeamCharge(run: Run, mode: Mode, id: string): Run {
	if (!mode.lifePool) return run
	const chargedByPlayer = { ...run.lifeLedger.lifeTakenFor }
	let changed = false
	for (const member of mode.lifePool.teamMemberIds(run, id)) {
		if (!chargedByPlayer[member]?.includes(TEAM_ALREADY_CHARGED)) continue
		chargedByPlayer[member] = chargedByPlayer[member].filter(
			(k) => k !== TEAM_ALREADY_CHARGED,
		)
		changed = true
	}
	return changed ? withLedger(run, { lifeTakenFor: chargedByPlayer }) : run
}

function losePooledLife(
	run: Run,
	mode: Mode,
	pool: LifePool,
	id: string,
	lifeCause: LifeCause,
): Run {
	const cause = eventCause(lifeCause)
	const chargedBlind = chargedBlindOf(lifeCause)
	const members = pool.teamMemberIds(run, id)
	if (members.length === 0) return run
	const lostPvpBlind = lifeCause.kind === 'pvp_blind'
	if (
		lifeCause.kind === 'blind' &&
		!isPvpBlindOf(run, id, lifeCause.blindKey)
	) {
		if ((run.lifeLedger.lifeTakenFor[id] ?? []).includes(TEAM_ALREADY_CHARGED))
			return run
		const charged = pool.takeLife(run, id, cause)
		const chargedByPlayer = { ...run.lifeLedger.lifeTakenFor }
		for (const member of members)
			chargedByPlayer[member] = [
				...(chargedByPlayer[member] ?? []),
				TEAM_ALREADY_CHARGED,
			]
		const next = withLedger(charged, { lifeTakenFor: chargedByPlayer })
		return next.lives[id].lives <= 0
			? openWaitingDeath(next, mode, id, cause)
			: next
	}
	const teammatesCharged = lostPvpBlind ? members : [id]
	const chargedBlinds = (member: string): string[] =>
		run.lifeLedger.lifeTakenFor[member] ?? []
	const markCharged = (game: Run): Run => {
		if (
			chargedBlind === null ||
			teammatesCharged.every((member) =>
				chargedBlinds(member).includes(chargedBlind),
			)
		)
			return game
		const chargedByPlayer = { ...run.lifeLedger.lifeTakenFor }
		for (const member of teammatesCharged)
			if (!chargedBlinds(member).includes(chargedBlind))
				chargedByPlayer[member] = [...chargedBlinds(member), chargedBlind]
		return withLedger(game, { lifeTakenFor: chargedByPlayer })
	}
	if (
		chargedBlind !== null &&
		teammatesCharged.some((member) =>
			chargedBlinds(member).includes(chargedBlind),
		) &&
		(!lostPvpBlind ||
			run.lives[id].events.some((e) => e.cause === chargedBlind))
	)
		// Blocked, but a lost PvP blind still marks every teammate charged.
		return markCharged(run)

	const charged = pool.takeLife(run, id, cause)
	const next = markCharged(charged)
	return next.lives[id].lives <= 0
		? openWaitingDeath(next, mode, id, cause)
		: next
}

// Every life loss goes through here: the mode's pool when it has one, else the player's.
export function chargeLife(
	run: Run,
	mode: Mode,
	id: string,
	cause: LifeCause,
): Run {
	return mode.lifePool
		? losePooledLife(run, mode, mode.lifePool, id, cause)
		: loseLife(run, mode, id, cause)
}

// The comeback bonus: a player who loses a life is owed one bonus item per life lost, in
// every mode and ruleset while the lobby's `gold_on_life_loss` is on (the default; no
// owners when `lifeLossGold` is 'none'). Only a loss counts, never a gain. `before` and `after` are the run's lives either
// side of one change; a player appears once per life lost, so a Teams pool loss names every
// teammate who shows it. The one rule: every change to a life is compared through here.
export function comebackBonusOwners(
	before: { [id: string]: PvpLifePlayer },
	after: { [id: string]: PvpLifePlayer },
	lifeLossGold: 'paid' | 'none',
): string[] {
	const owners: string[] = []
	if (lifeLossGold === 'none') return owners
	for (const [id, seat] of Object.entries(after)) {
		const earlier = before[id]
		if (earlier === undefined) continue
		const lost = seat.events
			.slice(earlier.events.length)
			.filter((event) => event.delta < 0).length
		for (let count = 0; count < lost; count++) owners.push(id)
	}
	return owners
}

// One life for a player still in the run with lives left. A player at 0, out
// of the run or unknown gets nothing: a gain never revives.
function gainLife(run: Run, id: string): Run {
	const playerLives = run.lives[id]
	if (
		!playerLives ||
		playerLives.lives <= 0 ||
		!inRunIgnoringLives(playerLives)
	)
		return run
	return withPlayerLives(run, id, {
		...playerLives,
		lives: playerLives.lives + 1,
		events: [...playerLives.events, { delta: 1, cause: null }],
	})
}

// A voucher action: the mode names the gainers, each gets one life.
export function gainVoucherLives(
	run: Run,
	mode: Mode,
	action: VoucherBought,
): Run {
	// A pooled game's lives are the team's: a gain never moves a pool.
	if (!mode.voucherGainers || mode.lifePool) return run
	const gainers = new Set(mode.voucherGainers(run, action))
	return [...gainers].reduce(gainLife, run)
}

// The one run-out of an Ante timer. A forgiven run-out is only used up; otherwise a
// life is lost, uncharged. The blind is unknown, so the event has no key and a last
// life opens a death with no blind to wait on.
export function handleTimerRunOut(
	run: Run,
	mode: Mode,
	id: string,
	forgiveness: 'applies' | 'none' = 'applies',
): Run {
	const runOutsUsed = run.lifeLedger.runOutsForgiven[id] ?? 0
	if (forgiveness === 'applies' && runOutsUsed < run.rules.timerForgiveness)
		return withLedger(run, {
			runOutsForgiven: {
				...run.lifeLedger.runOutsForgiven,
				[id]: runOutsUsed + 1,
			},
		})
	return chargeLife(run, mode, id, { kind: 'timer_ran_out' })
}

// Takes one player action.
export function applyAction(run: Run, action: PlayerAction, mode: Mode): Run {
	switch (action.type) {
		case 'forfeit': {
			const playerLives = run.lives[action.playerId]
			return playerLives &&
				playerLives.status !== 'forfeited' &&
				playerLives.status !== 'left'
				? withPlayerLives(run, action.playerId, {
						...playerLives,
						status: 'forfeited',
					})
				: run
		}
		case 'blind':
			return action.result === 'lost' && run.rules.failedBlindLife === 'costs'
				? chargeLife(run, mode, action.playerId, {
						kind: 'blind',
						blindKey: action.blindKey,
					})
				: run
		case 'progress':
			return resetTeamCharge(run, mode, action.playerId)
		case 'voucher':
			return gainVoucherLives(run, mode, {
				playerId: action.playerId,
				voucherKey: action.voucherKey,
			})
	}
}

// A player that left the lobby is out of the run, the same as a forfeit.
export function markLeft(run: Run, id: string): Run {
	const playerLives = run.lives[id]
	return playerLives && playerLives.status !== 'left'
		? withPlayerLives(run, id, { ...playerLives, status: 'left' })
		: run
}

// ---- writing the ledger's answer to the state ----

// Writes the ledger's answer `after` (a change of `before`'s lives) into the state, records
// the exits it made, and gives a comeback bonus item for every life lost (the rule is
// `comebackBonusOwners`). Every writer of lives goes through here.
export function writeLedger(state: State, before: Run, after: Run): State {
	const written: State = {
		...state,
		run: { ...after, exits: recordExits(before, after.lives) },
	}
	return comebackBonusOwners(
		before.lives,
		after.lives,
		after.rules.lifeLossGold,
	).reduce(
		(next, player) =>
			addInboxItem(next, player, {
				from: null,
				effect: 'comebackBonus',
				amount: 1,
			}),
		written,
	)
}

// Runs a change on the life ledger and writes the ledger's answer back.
export function changeLedger(state: State, change: (run: Run) => Run): State {
	const run = state.run
	if (run === null) return state
	return writeLedger(state, run, change(run))
}

// Takes one player action through the ledger.
export function takeAction(state: State, action: PlayerAction): State {
	return changeLedger(state, (run) => applyAction(run, action, modeOf(run)))
}
