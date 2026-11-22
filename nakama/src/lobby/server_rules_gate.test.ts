import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type ServerConfig, mergeConfig } from '../config'
import { everyoneOnServerRules } from '../standing/pvp_version'
import { type Referee, refereeOf, runningReferee, savedReferee } from './hooks'
import type { GameState } from './protocol'
import { withRules } from './pvp/testing/rules'
import { LIMITS } from './pvp/testing/state'
import { action } from './relay'
import { type Lobby, emptyGame, join, newLobby } from './state'

const CONFIG = { ...DEFAULT_CONFIG, pvpLimits: LIMITS }
const rules = (version: string): ServerConfig => ({
	...CONFIG,
	pvpServerRulesVersion: version,
})

describe('everyoneOnServerRules', () => {
	it.each([
		['all at the setting', '1.0.6', ['1.0.6', '1.0.6'], true],
		['all above the setting', '1.0.6', ['1.1.0', '2.0.0'], true],
		['one below', '1.0.6', ['1.0.6', '1.0.5'], false],
		['one unknown', '1.0.6', ['1.0.6', undefined], false],
		['one that is not X.Y.Z', '1.0.6', ['1.0.6', 'UNK'], false],
		['one empty', '1.0.6', ['1.0.6', ''], false],
		['no setting', '', ['1.0.6', '1.0.6'], false],
		['setting never given', undefined, ['1.0.6', '1.0.6'], false],
		['no players', '1.0.6', [], false],
	] as const)('%s', (_name, setting, versions, expected) => {
		expect(everyoneOnServerRules(setting, [...versions])).toBe(expected)
	})
})

const info = (name: string, pvpVersion?: string) => ({
	displayName: name,
	preferredJoker: null,
	mods: null,
	pvpVersion,
})

function lobbyOf(modId: string, versions: (string | undefined)[]): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId,
		maxPlayers: 8,
		creatorId: 'p0',
		now: 0,
		graceMs: 10_000,
		resultTimeoutMs: 60_000,
	})
	lobby = { ...lobby, metadata: withRules() }
	versions.forEach((version, i) => {
		lobby = join(lobby, `p${i}`, `p${i}-s1`, info(`p${i}`, version)).lobby
	})
	return lobby
}

function send(
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown,
	config: ServerConfig,
	to = 'server',
) {
	const ctx = {
		now: 1000,
		newSeed: () => 'SEED',
		newId: () => 'RUN',
		random: () => 0,
		config,
	}
	return action(
		lobby,
		from,
		{ cid: `${key}-${from}`, action: key, to, params },
		ctx,
	)
}

// Everyone else gets Ready, then p0 starts.
function started(lobby: Lobby, config: ServerConfig): Lobby {
	let next = lobby
	for (const seat of lobby.players.slice(1))
		next = send(next, seat.id, 'mpapi_ready', { ready: true }, config).lobby
	return send(next, 'p0', 'mpapi_start_game', { stake: 1 }, config).lobby
}

// The lobby after a game the server refereed is over: waiting again, with the
// result kept.
function afterServerGame(lobby: Lobby): Lobby {
	return { ...lobby, game: { ...emptyGame(), ended: lobby.game.pvp } }
}

function withVersion(lobby: Lobby, id: string, version?: string): Lobby {
	return {
		...lobby,
		players: lobby.players.map((seat) =>
			seat.id === id
				? { ...seat, info: { ...seat.info, pvpVersion: version } }
				: seat,
		),
	}
}

const places = [
	{ playerId: 'p1', place: 1 },
	{ playerId: 'p0', place: 2 },
]

describe('refereeOf with no game running', () => {
	it.each([
		['all new', 'MultiplayerPvP', '1.0.6', ['1.0.6', '1.0.7'], 'server'],
		['one old', 'MultiplayerPvP', '1.0.6', ['1.0.6', '1.0.5'], 'players'],
		['one unknown', 'MultiplayerPvP', '1.0.6', ['1.0.6', undefined], 'players'],
		['setting empty', 'MultiplayerPvP', '', ['1.0.6', '1.0.6'], 'players'],
		['another mod', 'MultiplayerSPDRN', '1.0.6', ['1.0.6', '1.0.6'], 'not_pvp'],
	] as const)('%s', (_name, modId, setting, versions, expected) => {
		const lobby = lobbyOf(modId, [...versions])
		expect(refereeOf(lobby, setting)).toBe(expected)
	})
})

describe('refereeOf with a game running', () => {
	it('stays with the server for a game it built, whoever joins later', () => {
		const lobby = started(
			lobbyOf('MultiplayerPvP', ['1.0.6', '1.0.6']),
			rules('1.0.6'),
		)
		expect(lobby.game.started?.referee).toBe('server')
		const crowded = join(lobby, 'p9', 'p9-s1', info('p9', '1.0.5')).lobby
		expect(refereeOf(crowded, '1.0.6')).toBe('server')
	})

	it('stays with the server when the setting is switched off mid-game', () => {
		const lobby = started(
			lobbyOf('MultiplayerPvP', ['1.0.6', '1.0.6']),
			rules('1.0.6'),
		)
		expect(refereeOf(lobby, '')).toBe('server')
	})

	it('stays with the players for a game they started, even when everyone is new later', () => {
		const lobby = started(
			lobbyOf('MultiplayerPvP', ['1.0.5', '1.0.5']),
			rules('1.0.6'),
		)
		expect(lobby.game.started?.referee).toBe('players')
		expect(lobby.game.pvp).toBeUndefined()
		const updated = withVersion(
			withVersion(lobby, 'p0', '1.0.6'),
			'p1',
			'1.0.6',
		)
		expect(refereeOf(updated, '1.0.6')).toBe('players')
	})
})

describe('the next start after a game the server refereed', () => {
	const served = () =>
		afterServerGame(
			started(lobbyOf('MultiplayerPvP', ['1.0.6', '1.0.6']), rules('1.0.6')),
		)

	it.each([
		['both seats now old', '1.0.5'],
		['both seats now unknown', undefined],
		['both seats now empty', ''],
	] as const)('is left to the players with %s', (_name, version) => {
		const lobby = withVersion(
			withVersion(served(), 'p0', version),
			'p1',
			version,
		)
		const next = started(lobby, rules('1.0.6'))
		expect(next.game.started?.referee).toBe('players')
		expect(next.game.pvp).toBeUndefined()
	})

	it('goes to the server again when everyone is still new', () => {
		const next = started(served(), rules('1.0.6'))
		expect(next.game.started?.referee).toBe('server')
		expect(next.game.pvp).toBeDefined()
	})

	it('has no running game to read before it starts, whoever sits now', () => {
		const lobby = withVersion(served(), 'p1', '1.0.5')
		expect(lobby.game.ended).toBeDefined()
		expect(runningReferee(lobby)).toBe('no_game')
		expect(refereeOf(lobby, '1.0.6')).toBe('players')
	})
})

describe('the setting as a kill switch', () => {
	it('is read again at every start of one lobby', () => {
		const first = started(
			lobbyOf('MultiplayerPvP', ['1.0.6', '1.0.6']),
			rules('1.0.6'),
		)
		expect(first.game.started?.referee).toBe('server')
		const second = started(afterServerGame(first), rules(''))
		expect(second.game.started?.referee).toBe('players')
		expect(second.game.pvp).toBeUndefined()
		const third = started({ ...second, game: emptyGame() }, rules('1.0.6'))
		expect(third.game.started?.referee).toBe('server')
	})
})

describe('a PvP lobby with the setting off', () => {
	const lobbyAtStart = () =>
		started(lobbyOf('MultiplayerPvP', ['1.0.5', '1.0.5']), rules(''))

	it('settles on the reports, as before', () => {
		const lobby = lobbyAtStart()
		expect(lobby.game.started?.referee).toBe('players')
		const first = send(
			lobby,
			'p0',
			'mpapi_report_result',
			{ placements: places },
			rules(''),
		)
		expect(first.lobby.game.started).not.toBeNull()
		const last = send(
			first.lobby,
			'p1',
			'mpapi_report_result',
			{ placements: places },
			rules(''),
		)
		expect(last.lobby.game.started).toBeNull()
		expect(last.out.some((o) => o.kind === 'saveRun')).toBe(true)
	})

	it('takes a result pending from a player', () => {
		const step = send(
			lobbyAtStart(),
			'p0',
			'mpapi_set_result_pending',
			{ pending: true },
			rules(''),
		)
		expect(step.lobby.game.resultPending).toBe(true)
	})

	it('lets the host abandon the game', () => {
		const step = send(lobbyAtStart(), 'p0', 'mpapi_abandon_game', {}, rules(''))
		expect(step.lobby.game.started).toBeNull()
		expect(step.out.some((o) => o.kind === 'saveRun')).toBe(true)
	})

	it('relays an action to the other player', () => {
		const step = send(
			lobbyAtStart(),
			'p0',
			'mp_location',
			{ x: 1 },
			rules(''),
			'*',
		)
		const delivered = step.out.filter(
			(o) =>
				o.kind === 'send' &&
				(o.payload as { action?: string }).action === 'mp_location',
		)
		expect(delivered).toHaveLength(1)
		expect(delivered[0]).toMatchObject({ to: ['p0', 'p1'] })
	})
})

describe('the referee of a game saved with the lobby', () => {
	const game = (
		referee: 'server' | 'players' | undefined,
		hasMatch: boolean,
	): GameState =>
		({
			...emptyGame(),
			started: {
				runId: 'r',
				seed: 's',
				stake: null,
				options: null,
				startedAt: 0,
				hostId: 'p0',
				players: [],
				...(referee === undefined ? {} : { referee }),
			},
			...(hasMatch ? { pvp: {} } : {}),
		}) as GameState

	it.each([
		['saved as the server', 'server', false, 'server'],
		['saved as the players', 'players', true, 'players'],
		['no referee and a PvP match', undefined, true, 'server'],
		['no referee and no PvP match', undefined, false, 'players'],
	] as const)('%s', (_name, referee, hasMatch, expected) => {
		expect(savedReferee(game(referee, hasMatch))).toBe(expected)
	})

	it('is read for a lobby of PvP only', () => {
		const read = (modId: string): Referee | 'no_game' =>
			runningReferee({
				...lobbyOf(modId, ['1.0.6']),
				game: game(undefined, true),
			})
		expect([read('MultiplayerPvP'), read('MultiplayerSPDRN')]).toEqual([
			'server',
			'not_pvp',
		])
	})
})

describe('the setting', () => {
	it.each([
		['1.0.6', '1.0.6'],
		['', ''],
		['1.0', ''],
		['v1.0.6', ''],
		[7, ''],
	] as const)('takes %j as %j', (given, kept) => {
		expect(
			mergeConfig(DEFAULT_CONFIG, { pvpServerRulesVersion: given })
				.pvpServerRulesVersion,
		).toBe(kept)
	})

	it('is off by default', () => {
		expect(DEFAULT_CONFIG.pvpServerRulesVersion).toBe('')
	})
})
