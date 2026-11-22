// Trap cards. The planter owns a trap and gets its reward; the target holds it and fires it
// when it goes off. The registry is `run.traps`, the only place that says who owns and holds.
import type { InputHandler } from '../core/apply'
import { addInboxItem } from '../core/inbox'
import type { PlayerId, State, Trap, TrapData } from '../core/types'
import { reachedBy } from '../rules/opponent_targets'
import { isInRun } from '../rules/players'

export type TrapInput =
	| { kind: 'trapPlant'; key: string; total: number }
	| { kind: 'trapFire'; trapId: number; data: TrapData }
	| { kind: 'trapLost'; trapId: number }

export const ARCANE_LOCK_KEY = 'c_mp_trap_arcane_lock'
const TRAP_KEY_MAX = 64
export const MAX_PLANTS_PER_KEY = 32
const MAX_TRAP_ID = 1_000_000
export const MAX_FIRE_DATA_KEYS = 16
export const MAX_FIRE_DATA_KEY_LENGTH = 32
export const MAX_FIRE_DATA_SIZE = 1024

const plantSpec = {
	key: { type: 'text', max: TRAP_KEY_MAX },
	total: { type: 'whole', max: MAX_PLANTS_PER_KEY },
} as const
// What a trap needs when it goes off is the client's; the server copies it to the owner as sent.
const fireSpec = {
	trapId: { type: 'whole', max: MAX_TRAP_ID },
	data: {
		type: 'record',
		maxKeys: MAX_FIRE_DATA_KEYS,
		maxKeyLength: MAX_FIRE_DATA_KEY_LENGTH,
		maxSize: MAX_FIRE_DATA_SIZE,
	},
} as const
const lostSpec = {
	trapId: { type: 'whole', max: MAX_TRAP_ID },
} as const

function withTraps(state: State, traps: Trap[]): State {
	if (state.run === null) return state
	return { ...state, run: { ...state.run, traps } }
}

function withTrapState(
	traps: Trap[],
	id: number,
	newState: Trap['state'],
): Trap[] {
	return traps.map((trap) =>
		trap.id === id ? { ...trap, state: newState } : trap,
	)
}

// The Arcane Lock the planter holds that has not gone off yet.
function liveLockHeldBy(traps: Trap[], player: PlayerId): Trap | undefined {
	return traps.find(
		(trap) =>
			trap.key === ARCANE_LOCK_KEY &&
			trap.holder === player &&
			trap.state === 'live',
	)
}

// A lock sends the planted card back to the lock's owner as one trap held by the planter,
// whether or not the planter has anyone to plant at, and the owner sees the lock go off.
function bounced(
	state: State,
	lock: Trap,
	key: string,
	planter: PlayerId,
): State {
	const traps = state.run?.traps ?? []
	const sent = withTraps(state, [
		...withTrapState(traps, lock.id, 'fired'),
		{
			id: traps.length + 1,
			key,
			owner: lock.owner,
			holder: planter,
			state: 'live',
		},
	])
	return addInboxItem(sent, lock.owner, {
		from: planter,
		effect: 'trapReward',
		amount: 1,
		trap: { id: lock.id, key: lock.key, data: {} },
	})
}

function plantedAt(
	state: State,
	key: string,
	planter: PlayerId,
	target: PlayerId,
): State {
	const traps = state.run?.traps ?? []
	return withTraps(state, [
		...traps,
		{
			id: traps.length + 1,
			key,
			owner: planter,
			holder: target,
			state: 'live',
		},
	])
}

export const trapPlantHandler: InputHandler<typeof plantSpec> = {
	spec: plantSpec,
	handle(state, player, body, _now, previousTotal) {
		const run = state.run
		const ante = run?.players[player]?.ante
		if (run === null || ante === null || ante === undefined)
			return { refusal: 'no_progress' }
		if (!isInRun(run, player)) return { refusal: 'eliminated' }
		const targets = reachedBy(state, player, 'every opponent')
		const planted = body.total - (previousTotal ?? 0)
		let next = state
		for (let count = 0; count < planted; count++) {
			const lock = liveLockHeldBy(next.run?.traps ?? [], player)
			if (lock !== undefined) next = bounced(next, lock, body.key, player)
			else
				for (const target of targets)
					next = plantedAt(next, body.key, player, target)
		}
		return next
	},
}

type HeldTrap =
	| { ok: true; trap: Trap }
	| { ok: false; refusal: 'not_holder' | 'already_fired' }

function liveTrapHeldBy(state: State, player: PlayerId, id: number): HeldTrap {
	const trap = state.run?.traps.find((each) => each.id === id)
	if (trap === undefined || trap.holder !== player)
		return { ok: false, refusal: 'not_holder' }
	return trap.state === 'live'
		? { ok: true, trap }
		: { ok: false, refusal: 'already_fired' }
}

export const trapFireHandler: InputHandler<typeof fireSpec> = {
	spec: fireSpec,
	handle(state, player, body) {
		const held = liveTrapHeldBy(state, player, body.trapId)
		if (!held.ok) return { refusal: held.refusal }
		const trap = held.trap
		if (trap.key === ARCANE_LOCK_KEY) return { refusal: 'arcane_lock' }
		const fired = withTraps(
			state,
			withTrapState(state.run?.traps ?? [], trap.id, 'fired'),
		)
		return addInboxItem(fired, trap.owner, {
			from: player,
			effect: 'trapReward',
			amount: 1,
			trap: { id: trap.id, key: trap.key, data: body.data },
		})
	},
}

export const trapLostHandler: InputHandler<typeof lostSpec> = {
	spec: lostSpec,
	handle(state, player, body) {
		const held = liveTrapHeldBy(state, player, body.trapId)
		if (!held.ok) return { refusal: held.refusal }
		const trap = held.trap
		return withTraps(
			state,
			withTrapState(state.run?.traps ?? [], trap.id, 'lost'),
		)
	},
}

// A player gets the traps it owns or holds, and no others.
export function trapsView(state: State, viewer: PlayerId): Trap[] {
	return (state.run?.traps ?? [])
		.filter((trap) => trap.owner === viewer || trap.holder === viewer)
		.map((trap) => ({ ...trap }))
}
