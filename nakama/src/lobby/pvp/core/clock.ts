// Countdowns, player pauses and their budgets: the one countdown shape of a PvP run.
//
// A countdown is two fixed server times, `endsAt` and its hold's `sinceAt`; nothing in state
// counts down. Counting: left = endsAt - now. Held or paused: left = endsAt - sinceAt. A resume moves
// endsAt by the time paused, so a pause never costs time left.
//
// A player pause holds the countdowns it applies to: away holds every countdown; animating
// holds only those running against the animating player, never an Ante countdown (main counts
// animation time on the default Ante timer). An away pause is charged for every moment the
// player is away and holds until they are back: the one away budget of the run, whose end is
// the player's forfeit (`awayForfeitAt`). A server restart pause holds the same way and is never
// charged: waiting for players to reconnect after a restart is not their away time. An animating pause is charged only while it holds a
// countdown, and holds while it still has budget. Budgets come from `run.rules.limits`, passed in
// by the caller; nothing here reads a constant.
//
// Order: every function first settles the clocks up to `now` (charging the pauses), then
// makes its change at `now`. Run-outs are read from settled clocks (`countdownsAtZero`).
import type {
	BlindKey,
	Clocks,
	Countdown,
	CountdownState,
	Milliseconds,
	PlayerClock,
	PlayerId,
	PlayerPause,
	PvpLimits,
	State,
} from './types'

type WhichCountdowns = (countdown: Countdown) => boolean

interface NewCountdownBase {
	by: PlayerId | null
	against: PlayerId[]
	lengthMilliseconds: number
}

export type NewCountdown =
	| (NewCountdownBase & {
			kind: 'ante'
			// The Boss it presses for.
			blindKey: BlindKey
	  })
	| (NewCountdownBase & { kind: 'pvp' })
	| (NewCountdownBase & { kind: 'personal' })

// A countdown that is counting, or is held only because a player is away or animating.
// One its starter paused, or a personal one paused for the PvP blind, is not counting.
export const isCounting = (countdown: Countdown): boolean =>
	countdown.hold.kind === 'counting' ||
	countdown.hold.kind === 'held for player'

// The server time a held or paused countdown stopped at; null while it counts.
export const stoppedAt = (countdown: Countdown): Milliseconds | null =>
	countdown.hold.kind === 'counting' ? null : countdown.hold.sinceAt

// A personal countdown against `player`.
export const isPersonalFor = (countdown: Countdown, player: PlayerId): boolean =>
	countdown.kind === 'personal' && countdown.against.includes(player)

// Whether a counting Ante countdown presses `player`.
export const isTimed = (clocks: Clocks, player: PlayerId): boolean =>
	clocks.countdowns.some(
		(countdown) =>
			countdown.kind === 'ante' &&
			isCounting(countdown) &&
			countdown.against.includes(player),
	)

export function changeClocks(
	state: State,
	change: (clocks: Clocks) => Clocks,
): State {
	const run = state.run
	return run === null
		? state
		: { ...state, run: { ...run, clocks: change(run.clocks) } }
}

export function newClocks(
	players: PlayerId[],
	limits: PvpLimits,
	now: Milliseconds,
): Clocks {
	const clocks: { [player: PlayerId]: PlayerClock } = {}
	for (const player of players)
		clocks[player] = {
			awayLeftMilliseconds: limits.awayBudgetMilliseconds,
			animatingBlindLeftMilliseconds: limits.animatingBlindMilliseconds,
		}
	return { countdowns: [], playerPauses: [], players: clocks, settledAt: now }
}

// Time left on a countdown, running or paused.
export function timeLeft(countdown: Countdown, now: Milliseconds): number {
	return countdown.endsAt - (stoppedAt(countdown) ?? now)
}

function playerClock(clocks: Clocks, player: PlayerId): PlayerClock {
	const own = clocks.players[player]
	if (own === undefined) throw new Error(`no clock for player ${player}`)
	return own
}

export function pauseLeft(clocks: Clocks, pause: PlayerPause): number {
	const own = playerClock(clocks, pause.player)
	return pause.reason === 'animating'
		? Math.min(pause.holdLeftMilliseconds, own.animatingBlindLeftMilliseconds)
		: own.awayLeftMilliseconds
}

// A player who is not at the table, whatever the reason.
export const isAwayPause = (pause: PlayerPause): boolean =>
	pause.reason !== 'animating'

// Whether `pause` applies to `countdown`.
export const pauseApplies = (
	pause: PlayerPause,
	countdown: Countdown,
): boolean =>
	isAwayPause(pause) ||
	(countdown.kind !== 'ante' && countdown.against.includes(pause.player))

// Whether a player pause holds `countdown`. An away pause holds until the player is back; a
// spent away budget ends their game (`awayForfeitAt`), it never resumes the timers.
const isHeldFor = (clocks: Clocks, countdown: Countdown): boolean =>
	clocks.playerPauses.some(
		(pause) =>
			pauseApplies(pause, countdown) &&
			(isAwayPause(pause) || pauseLeft(clocks, pause) > 0),
	)

// When an away player's budget runs out and they lose the game; null for a player with no
// clock. `awaySince` is when they dropped, and their pause starts there: before it starts the
// budget is counted from `awaySince`, after it from `settledAt`, the same moment.
export function awayForfeitAt(
	clocks: Clocks,
	player: PlayerId,
	awaySince: Milliseconds,
): Milliseconds | null {
	const own = clocks.players[player]
	if (own === undefined) return null
	const paused = clocks.playerPauses.some(
		(pause) => pause.player === player && pause.reason === 'away',
	)
	const from = paused ? clocks.settledAt : Math.max(awaySince, clocks.settledAt)
	return from + own.awayLeftMilliseconds
}

// Pauses the countdowns while a player pause has room, and resumes the ones a player pause
// held when none has.
function applyPauses(clocks: Clocks, at: Milliseconds): Clocks {
	return {
		...clocks,
		countdowns: clocks.countdowns.map((countdown) => {
			const { hold } = countdown
			const paused = isHeldFor(clocks, countdown)
			if (paused && hold.kind === 'counting')
				return { ...countdown, hold: { kind: 'held for player', sinceAt: at } }
			if (!paused && hold.kind === 'held for player')
				return {
					...countdown,
					endsAt: countdown.endsAt + (at - hold.sinceAt),
					hold: { kind: 'counting' },
				}
			return countdown
		}),
	}
}

function charge(clocks: Clocks, active: PlayerPause[], step: number): Clocks {
	const players = { ...clocks.players }
	// A pause is found by player and reason, never by identity: live, every read of the
	// state is a new object.
	const playerPauses = clocks.playerPauses.map((pause) => {
		if (
			!active.some(
				(found) =>
					found.player === pause.player && found.reason === pause.reason,
			)
		)
			return pause
		const own = playerClock({ ...clocks, players }, pause.player)
		if (pause.reason === 'server restart') return pause
		if (pause.reason === 'away') {
			players[pause.player] = {
				...own,
				awayLeftMilliseconds: own.awayLeftMilliseconds - step,
			}
			return pause
		}
		players[pause.player] = {
			...own,
			animatingBlindLeftMilliseconds: own.animatingBlindLeftMilliseconds - step,
		}
		return { ...pause, holdLeftMilliseconds: pause.holdLeftMilliseconds - step }
	})
	return { ...clocks, players, playerPauses }
}

// Charges the pauses for the time since the last catchUpClocks, in steps that end where a budget runs out.
export function catchUpClocks(clocks: Clocks, now: Milliseconds): Clocks {
	let current = clocks
	while (current.settledAt < now) {
		const held = current.countdowns.filter(
			(countdown) => countdown.hold.kind === 'held for player',
		)
		const active = current.playerPauses.filter(
			(pause) =>
				pause.reason !== 'server restart' &&
				pauseLeft(current, pause) > 0 &&
				(pause.reason === 'away' ||
					held.some((countdown) => pauseApplies(pause, countdown))),
		)
		if (active.length === 0) return { ...current, settledAt: now }
		const step = Math.min(
			now - current.settledAt,
			...active.map((pause) => pauseLeft(current, pause)),
		)
		const at = current.settledAt + step
		current = applyPauses(
			{ ...charge(current, active, step), settledAt: at },
			at,
		)
	}
	return current
}

export function startPlayerPause(
	clocks: Clocks,
	player: PlayerId,
	reason: PlayerPause['reason'],
	limits: PvpLimits,
	now: Milliseconds,
): Clocks {
	playerClock(clocks, player)
	const settled = catchUpClocks(clocks, now)
	if (
		settled.playerPauses.some((s) => s.player === player && s.reason === reason)
	)
		return settled
	const pause: PlayerPause =
		reason === 'animating'
			? {
					player,
					reason,
					holdLeftMilliseconds: limits.animatingHoldMilliseconds,
				}
			: { player, reason }
	return applyPauses(
		{ ...settled, playerPauses: [...settled.playerPauses, pause] },
		now,
	)
}

export function endPlayerPause(
	clocks: Clocks,
	player: PlayerId,
	reason: PlayerPause['reason'],
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	return applyPauses(
		{
			...settled,
			playerPauses: settled.playerPauses.filter(
				(pause) => pause.player !== player || pause.reason !== reason,
			),
		},
		now,
	)
}

// A PvP blind starts: every player's animating budget is full again.
export function refillAnimatingBudgets(
	clocks: Clocks,
	limits: PvpLimits,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	const players: { [player: PlayerId]: PlayerClock } = {}
	for (const player of Object.keys(settled.players))
		players[player] = {
			...settled.players[player],
			animatingBlindLeftMilliseconds: limits.animatingBlindMilliseconds,
		}
	return { ...settled, players }
}

export function startCountdown(
	clocks: Clocks,
	made: NewCountdown,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	const hold: CountdownState = { kind: 'counting' }
	const base = {
		by: made.by,
		against: made.against,
		endsAt: now + made.lengthMilliseconds,
		hold,
	}
	const countdown: Countdown =
		made.kind === 'ante'
			? { ...base, kind: 'ante', blindKey: made.blindKey }
			: made.kind === 'personal'
				? { ...base, kind: 'personal', rate: 1 }
				: { ...base, kind: made.kind }
	return applyPauses(
		{ ...settled, countdowns: [...settled.countdowns, countdown] },
		now,
	)
}

// The countdown's own pause: the starter's (timerPause) or, for a personal countdown, the
// PvP blind's. A countdown a player pause holds becomes this pause; one already paused stays.
export function pauseCountdowns(
	clocks: Clocks,
	which: WhichCountdowns,
	now: Milliseconds,
	kind:
		| 'paused by starter'
		| 'paused until timed'
		| 'paused for pvp blind' = 'paused by starter',
): Clocks {
	const settled = catchUpClocks(clocks, now)
	return {
		...settled,
		countdowns: settled.countdowns.map((countdown) => {
			if (!which(countdown) || !isCounting(countdown)) return countdown
			return {
				...countdown,
				hold: {
					kind,
					sinceAt: stoppedAt(countdown) ?? now,
				},
			}
		}),
	}
}

// Ends the countdown's own pause, whoever's; while a player pause has room it stays paused, held by it.
export function resumeCountdowns(
	clocks: Clocks,
	which: WhichCountdowns,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	return {
		...settled,
		countdowns: settled.countdowns.map((countdown) => {
			const { hold } = countdown
			const paused = isHeldFor(settled, countdown)
			if (
				!which(countdown) ||
				(hold.kind !== 'paused by starter' &&
					hold.kind !== 'paused until timed' &&
					hold.kind !== 'paused for pvp blind')
			)
				return countdown
			if (paused)
				return {
					...countdown,
					hold: { kind: 'held for player', sinceAt: hold.sinceAt },
				}
			return {
				...countdown,
				endsAt: countdown.endsAt + (now - hold.sinceAt),
				hold: { kind: 'counting' },
			}
		}),
	}
}

const isPausedFor = (countdown: Countdown, player: PlayerId): boolean =>
	countdown.kind === 'ante' &&
	countdown.hold.kind === 'paused for ready' &&
	countdown.against.includes(player)

// A player who is Ready for `blindKey` stops being timed by the Ante countdowns that have
// time left on them: each splits into the others it still presses and one against the
// player alone, frozen with the time the player had.
export function pauseForReady(
	clocks: Clocks,
	player: PlayerId,
	blindKey: BlindKey,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	const frozen: Countdown[] = []
	const kept = settled.countdowns.flatMap((countdown) => {
		if (
			countdown.kind !== 'ante' ||
			countdown.blindKey !== blindKey ||
			!countdown.against.includes(player) ||
			timeLeft(countdown, now) <= 0
		)
			return [countdown]
		frozen.push({
			...countdown,
			against: [player],
			hold: {
				kind: 'paused for ready',
				sinceAt: stoppedAt(countdown) ?? now,
				after: isCounting(countdown) ? 'counting' : 'paused by starter',
			},
		})
		const others = countdown.against.filter((id) => id !== player)
		return others.length === 0 ? [] : [{ ...countdown, against: others }]
	})
	return { ...settled, countdowns: [...kept, ...frozen] }
}

// The starter stopped or restarted their Ante timer: the frozen countdowns they started
// return to that state when their target is not Ready any more.
export function setPausedAfter(
	clocks: Clocks,
	starter: PlayerId,
	after: 'counting' | 'paused by starter',
): Clocks {
	return {
		...clocks,
		countdowns: clocks.countdowns.map((countdown) =>
			countdown.kind === 'ante' &&
			countdown.by === starter &&
			countdown.hold.kind === 'paused for ready'
				? { ...countdown, hold: { ...countdown.hold, after } }
				: countdown,
		),
	}
}

// The player is not Ready any more: their frozen Ante countdowns go back to what their
// starter's timer is doing: on from the time they had, or paused with it.
export function resumeAfterReady(
	clocks: Clocks,
	player: PlayerId,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	const counting = new Set<Countdown>()
	const waiting: Clocks = {
		...settled,
		countdowns: settled.countdowns.map((countdown) => {
			const { hold } = countdown
			if (hold.kind !== 'paused for ready' || !isPausedFor(countdown, player))
				return countdown
			const next: Countdown = {
				...countdown,
				hold: { kind: 'paused by starter', sinceAt: hold.sinceAt },
			}
			if (hold.after === 'counting') counting.add(next)
			return next
		}),
	}
	return resumeCountdowns(waiting, (countdown) => counting.has(countdown), now)
}

export function removeCountdowns(
	clocks: Clocks,
	which: WhichCountdowns,
	now: Milliseconds,
): Clocks {
	const settled = catchUpClocks(clocks, now)
	return {
		...settled,
		countdowns: settled.countdowns.filter((countdown) => !which(countdown)),
	}
}

// The running countdowns that have run out, earliest first. Read from settled clocks.
export function countdownsAtZero(clocks: Clocks, now: Milliseconds): Countdown[] {
	return clocks.countdowns
		.map((countdown, index) => ({ countdown, index }))
		.filter(
			({ countdown }) =>
				countdown.hold.kind === 'counting' && countdown.endsAt <= now,
		)
		.sort(
			(a, b) => a.countdown.endsAt - b.countdown.endsAt || a.index - b.index,
		)
		.map(({ countdown }) => countdown)
}

// After a graceful restart no one counted the downtime: every time field moves by it.
// A time field is one whose name ends in `At`. The list is by hand: a new time field in
// the state type fails the typecheck of shift_times_covers_every_time_field until the
// test fixture and this function have it.
export function shiftTimes(state: State, downtime: Milliseconds): State {
	return changeClocks(state, (clocks) => ({
		...clocks,
		settledAt: clocks.settledAt + downtime,
		countdowns: clocks.countdowns.map((countdown) => ({
			...countdown,
			endsAt: countdown.endsAt + downtime,
			hold:
				countdown.hold.kind === 'counting'
					? countdown.hold
					: { ...countdown.hold, sinceAt: countdown.hold.sinceAt + downtime },
		})),
	}))
}
