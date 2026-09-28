// Authoritative actions: the MPAPI ActionTypes declared `authoritative = true`
// (MPAPI api/action/builtin.lua), which the server runs instead of relaying.
// Every other action -- anything mod-specific -- is relayed untouched
// (lobby/relay.ts), so the server never needs to know a mod's actions.
//
// Pure: a reducer gets the lobby and its context and returns the new game
// state plus the results to broadcast, or a rejection reason for the sender.
import type { GameState } from '../lobby/protocol'
import type { Lobby } from '../lobby/state'

export interface ActionContext {
	from: string
	now: number
	// A fresh Balatro seed (injected so reducers stay deterministic in tests).
	newSeed: () => string
}

// A result broadcast to every player as ACTION {from:'server'}.
export interface ActionResult {
	game: GameState
	params: unknown
}

export type Reduction = ActionResult | { reject: string }

export interface AuthoritativeAction {
	key: string
	reduce(lobby: Lobby, ctx: ActionContext, params: unknown): Reduction
}

const MAX_OPTIONS_BYTES = 4 * 1024

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// {ready: boolean} -- the sender's own ready flag.
const ready: AuthoritativeAction = {
	key: 'mpapi_ready',
	reduce(lobby, ctx, params) {
		if (!isPlainObject(params) || typeof params.ready !== 'boolean')
			return { reject: 'bad_params' }
		if (lobby.game.started) return { reject: 'in_game' }
		const readyMap = { ...lobby.game.ready }
		if (params.ready) readyMap[ctx.from] = true
		else delete readyMap[ctx.from]
		return {
			game: { ...lobby.game, ready: readyMap },
			params: { playerId: ctx.from, ready: params.ready },
		}
	},
}

// {stake?, options?} -- host only, once every other connected player is
// ready. The server picks the seed, so the host can't.
const startGame: AuthoritativeAction = {
	key: 'mpapi_start_game',
	reduce(lobby, ctx, params) {
		const p = isPlainObject(params) ? params : {}
		if (p.stake !== undefined && typeof p.stake !== 'number')
			return { reject: 'bad_params' }
		const options = p.options === undefined ? null : p.options
		if (JSON.stringify(options).length > MAX_OPTIONS_BYTES)
			return { reject: 'bad_params' }
		if (lobby.hostId !== ctx.from) return { reject: 'not_host' }
		if (lobby.game.started) return { reject: 'in_game' }
		const present = lobby.players.filter((pl) => pl.awaySince === null)
		if (present.length < 2) return { reject: 'too_few_players' }
		for (const pl of present) {
			if (pl.id !== lobby.hostId && !lobby.game.ready[pl.id])
				return { reject: 'not_all_ready' }
		}
		const started = {
			seed: ctx.newSeed(),
			stake: typeof p.stake === 'number' ? p.stake : null,
			options,
			startedAt: ctx.now,
		}
		return {
			game: { ready: {}, started },
			params: { seed: started.seed, stake: started.stake, options },
		}
	},
}

const REGISTRY: { [key: string]: AuthoritativeAction } = {
	[ready.key]: ready,
	[startGame.key]: startGame,
}

export function authoritativeAction(key: string): AuthoritativeAction | null {
	return Object.prototype.hasOwnProperty.call(REGISTRY, key)
		? REGISTRY[key]
		: null
}

// Balatro's seed alphabet: 1-9 and A-Z without O (G.CONTROLLER seed entry).
const SEED_ALPHABET = '123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
export const SEED_LENGTH = 8

// Turns random hex (e.g. a UUID) into a Balatro seed.
export function seedFromHex(hex: string): string {
	const digits = hex.replace(/[^0-9a-f]/gi, '')
	let seed = ''
	for (let i = 0; i < SEED_LENGTH; i++) {
		const n = Number.parseInt(digits.substr(i * 3, 3) || '0', 16)
		seed += SEED_ALPHABET[n % SEED_ALPHABET.length]
	}
	return seed
}
