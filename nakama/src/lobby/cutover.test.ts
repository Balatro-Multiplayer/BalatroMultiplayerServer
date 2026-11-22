// The cutover: a PvP lobby is refereed by the server, every other mod keeps its old path.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restartedStep } from '../actions/registry'
import { settle } from '../actions/results'
import { draftActor } from '../actions/setup'
import { DEFAULT_CONFIG, type ServerConfig, writeConfig } from '../config'
import { pvpVersionRefusals } from '../matchmaking/gate'
import { PVP_MOD_ID } from '../standing/pvp_version'
import { writeModReport } from '../standing/storage'
import { type FakeNk, fakeLogger, fakeNk, playerCtx } from '../testing/fake_nk'
import { type Checkpoint, resumeFrom } from './checkpoint'
import {
	type LobbyMatchState,
	lobbyMatchJoin,
	lobbyMatchJoinAttempt,
	lobbyMatchLeave,
	lobbyMatchLoop,
	lobbyMatchSignal,
} from './match'
import {
	ClientOp,
	type DraftResult,
	RUNS_COLLECTION,
	ServerOp,
} from './protocol'
import type { State } from './pvp/core/types'
import { pvpHooks, resumeState } from './pvp/match_hooks/pvp_shell'
import { withRules } from './pvp/testing/rules'
import { LIMITS } from './pvp/testing/state'
import { action } from './relay'
import {
	type Lobby,
	type Outbound,
	type Step,
	disconnect,
	emptyGame,
	join,
	newLobby,
} from './state'

const CONFIG: ServerConfig = {
	...DEFAULT_CONFIG,
	pvpLimits: LIMITS,
	pvpServerRulesVersion: '1.0.0',
}
const NOW = 10_000

const info = (pvpVersion?: string) => ({
	displayName: 'x',
	preferredJoker: null,
	mods: null,
	...(pvpVersion === undefined ? {} : { pvpVersion }),
})

const ctx = (now: number, config?: ServerConfig) => ({
	now,
	newSeed: () => 'NEWSEED',
	newId: () => 'run-2',
	random: () => 0,
	...(config === undefined ? {} : { config }),
})

function send(
	lobby: Lobby,
	from: string,
	key: string,
	params: unknown,
	now: number,
	config?: ServerConfig,
) {
	return action(
		lobby,
		from,
		{ cid: `${key}-${from}`, action: key, to: 'server', params },
		ctx(now, config),
	)
}

const rejectionOf = (step: Step): string | undefined => {
	const out = step.out.find(
		(o) => o.kind === 'send' && o.op === ServerOp.ACTION_REJECTED,
	)
	return out?.kind === 'send'
		? (out.payload as { reason: string }).reason
		: undefined
}

function readyLobby(modId: string, over: { rankedMode?: string } = {}): Lobby {
	let lobby = newLobby({
		code: 'ABC123',
		modId,
		maxPlayers: 8,
		creatorId: 'ann',
		now: 0,
		graceMs: 120_000,
		resultTimeoutMs: 60_000,
		...(over.rankedMode === undefined ? {} : { rankedMode: over.rankedMode }),
	})
	lobby = { ...lobby, metadata: withRules() }
	for (const id of ['ann', 'bob'])
		lobby = join(lobby, id, `${id}-s1`, info('1.0.5')).lobby
	return send(lobby, 'bob', 'mpapi_ready', { ready: true }, 1000).lobby
}

function startedPvp(over: { rankedMode?: string } = {}): Lobby {
	const step = send(
		readyLobby(PVP_MOD_ID, over),
		'ann',
		'mpapi_start_game',
		{ stake: 1 },
		1000,
		CONFIG,
	)
	if (rejectionOf(step) !== undefined) throw new Error(rejectionOf(step))
	return step.lobby
}

const saved = (out: Outbound[]) =>
	out.find(
		(o): o is Extract<Outbound, { kind: 'saveRun' }> => o.kind === 'saveRun',
	)?.run

// The lobby with its match decided: `result`, and the places the core put the players in.
function decided(
	lobby: Lobby,
	result: NonNullable<State['result']>,
	places: { [playerId: string]: number },
): Lobby {
	const pvp = lobby.game.pvp as State
	const run = pvp.run as NonNullable<State['run']>
	return {
		...lobby,
		game: { ...lobby.game, pvp: { ...pvp, result, run: { ...run, places } } },
	}
}

describe('starting a PvP game', () => {
	it('builds the PvP match with the game', () => {
		const lobby = startedPvp()
		expect(lobby.game.started?.runId).toBe('run-2')
		expect(lobby.game.pvp?.run?.id).toBe('run-2')
	})

	it('is refused when the lobby has no config to hand the mod', () => {
		const step = send(
			readyLobby(PVP_MOD_ID),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		)
		expect(rejectionOf(step)).toBe('no_config')
		expect(step.lobby.game.started).toBeNull()
	})

	it('is refused when the mod cannot build the run from the lobby rules', () => {
		const lobby = { ...readyLobby(PVP_MOD_ID), metadata: {} }
		const step = send(
			lobby,
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
			CONFIG,
		)
		expect(rejectionOf(step)).toBe('bad_rules')
		expect(step.lobby.game.started).toBeNull()
	})

	it('leaves another mod with no PvP match', () => {
		const step = send(
			readyLobby('MultiplayerSPDRN'),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		)
		expect(step.lobby.game.started).not.toBeNull()
		expect(step.lobby.game.pvp).toBeUndefined()
	})
})

describe('the result actions of a PvP lobby', () => {
	const placements = [
		{ playerId: 'ann', place: 1 },
		{ playerId: 'bob', place: 2 },
	]
	it.each([
		['mpapi_report_result', { placements }],
		['mpapi_set_result_pending', { pending: true }],
		['mpapi_abandon_game', {}],
	])('%s is refused for everyone, the host too', (key, params) => {
		const lobby = startedPvp()
		for (const from of ['ann', 'bob']) {
			const step = send(lobby, from, key, params, 2000, CONFIG)
			expect(rejectionOf(step)).toBe('server_referee')
			expect(step.lobby.game).toEqual(lobby.game)
		}
	})

	it('are still taken from another mod', () => {
		const lobby = send(
			readyLobby('MultiplayerSPDRN'),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		).lobby
		expect(
			rejectionOf(send(lobby, 'ann', 'mpapi_abandon_game', {}, 2000)),
		).toBeUndefined()
	})
})

describe('settle in a PvP lobby', () => {
	const withResult = (
		lobby: Lobby,
		result: NonNullable<State['result']>,
	): Lobby => {
		const pvp = lobby.game.pvp as State
		return { ...lobby, game: { ...lobby.game, pvp: { ...pvp, result } } }
	}

	it('never ends the run on the report clock', () => {
		const lobby = startedPvp()
		for (const at of [2000, 2000 + 60_000, 2000 + 10 * 60_000]) {
			const step = settle(lobby, at)
			expect(step.out).toEqual([])
			expect(step.lobby).toBe(lobby)
		}
	})

	it.each([
		[
			'a win',
			{ kind: 'win', winners: ['ann'], rating: 'rated' },
			{ ann: 1, bob: 2 },
			[1, 2],
		],
		['a draw', { kind: 'draw', rating: 'rated' }, { ann: 1, bob: 1 }, [1, 1]],
	] as [
		string,
		NonNullable<State['result']>,
		{ [playerId: string]: number },
		number[],
	][])(
		'stores %s agreed with the places the core decided, and announces them',
		(_name, result, places, order) => {
			const step = settle(decided(startedPvp(), result, places), 5000)
			const placements = [
				{ playerId: 'ann', place: order[0] },
				{ playerId: 'bob', place: order[1] },
			]
			expect(saved(step.out)).toMatchObject({ status: 'agreed', placements })
			expect(step.out).toContainEqual(
				expect.objectContaining({
					kind: 'send',
					op: ServerOp.EVENT,
					payload: expect.objectContaining({
						type: 'game_ended',
						data: { runId: 'run-2', status: 'agreed', placements },
					}),
					to: ['ann', 'bob'],
				}),
			)
		},
	)

	it('stores a contested run as contested, even when the mod ended it as a win', () => {
		const lobby = decided(
			startedPvp(),
			{ kind: 'win', winners: ['ann'], rating: 'rated' },
			{ ann: 1, bob: 2 },
		)
		const contested: Lobby = {
			...lobby,
			game: { ...lobby.game, contest: { by: 'bob', against: 'ann', at: 3000 } },
		}
		expect(saved(settle(contested, 5000).out)?.status).toBe('contested')
	})

	describe('waits for the logs to close', () => {
		const line = (opcode: string) => JSON.stringify([0, opcode, {}])
		const open = [line('play')]
		const closed = [line('play'), line('end')]
		const withLogs = (
			lobby: Lobby,
			lines: { [id: string]: string[] },
		): Lobby => {
			const logs: Lobby['game']['logs'] = {}
			for (const id in lines)
				logs[id] = { lines: lines[id], bytes: 0, truncated: false }
			return { ...lobby, game: { ...lobby.game, logs } }
		}
		const won = () =>
			decided(
				startedPvp(),
				{ kind: 'win', winners: ['ann'], rating: 'rated' },
				{ ann: 1, bob: 2 },
			)

		it('stores the run once every open log has its end', () => {
			const held = settle(withLogs(won(), { ann: closed, bob: open }), 5000)
			expect(saved(held.out)).toBeUndefined()
			const both = withLogs(held.lobby, { ann: closed, bob: closed })
			expect(saved(settle(both, 5500).out)?.status).toBe('agreed')
		})

		it('stores the run on the result clock when a log never closes', () => {
			const held = settle(withLogs(won(), { ann: open, bob: closed }), 5000)
			const late = (at: number) => saved(settle(held.lobby, at).out)
			expect(late(5000 + 59_999)).toBeUndefined()
			expect(late(5000 + 60_000)?.status).toBe('agreed')
		})
	})

	it('leaves a passed seed vote to the match loop', () => {
		const lobby = withResult(startedPvp(), { kind: 'restarted' })
		const step = settle(lobby, 5000)
		expect(step.out).toEqual([])
		expect(step.lobby).toBe(lobby)
	})
})

describe('restartedStep', () => {
	it('builds the next game on a new seed with no host, and stores the old one restarted', () => {
		const lobby = startedPvp()
		const step = restartedStep(lobby, ctx(5000, CONFIG))
		if ('reject' in step) throw new Error(step.reject)
		expect(saved(step.out)?.status).toBe('restarted')
		expect(step.lobby.game.started).toMatchObject({
			runId: 'run-2',
			seed: 'NEWSEED',
		})
		expect(step.lobby.game.pvp?.run?.id).toBe('run-2')
		const told = step.out.find(
			(o) => o.kind === 'send' && o.op === ServerOp.ACTION,
		)
		expect(told).toMatchObject({
			payload: { action: 'mpapi_restart_game', from: 'server' },
			to: ['ann', 'bob'],
		})
	})

	it('refuses a lobby with no game', () => {
		expect(restartedStep(readyLobby(PVP_MOD_ID), ctx(5000, CONFIG))).toEqual({
			reject: 'not_in_game',
		})
	})

	it('is refused when the mod cannot build the next game', () => {
		expect(restartedStep(startedPvp(), ctx(5000))).toEqual({
			reject: 'no_config',
		})
	})

	it('is still the host action for a host restart', () => {
		const lobby = send(
			readyLobby('MultiplayerSPDRN'),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		).lobby
		expect(
			rejectionOf(send(lobby, 'bob', 'mpapi_restart_game', {}, 2000)),
		).toBe('not_host')
		expect(
			rejectionOf(send(lobby, 'ann', 'mpapi_restart_game', {}, 2000)),
		).toBeUndefined()
	})
})

describe('the match loop of a PvP lobby', () => {
	afterEach(() => vi.restoreAllMocks())

	const presence = (userId: string, session = `${userId}-s1`) =>
		({
			userId,
			sessionId: session,
			username: userId,
			node: 'n',
		}) as nkruntime.Presence
	const speedrunLobby = () =>
		send(
			readyLobby('MultiplayerSPDRN'),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		).lobby

	interface World {
		fake: FakeNk
		nk: nkruntime.Nakama
		sent: { op: number; payload: unknown; to: string[] }[]
		kicked: string[]
		dispatcher: nkruntime.MatchDispatcher
		mctx: nkruntime.Context
		state: LobbyMatchState
	}
	function world(lobby: Lobby): World {
		const fake = fakeNk({
			sha256Hash: (s: string) => `h${s.length}`,
			binaryToString: (d: string) => d,
		})
		const nk = fake as unknown as nkruntime.Nakama
		writeConfig(nk, CONFIG)
		const sent: World['sent'] = []
		const kicked: string[] = []
		const dispatcher = {
			broadcastMessage: (
				op: number,
				data: string,
				targets: nkruntime.Presence[],
			) =>
				sent.push({
					op,
					payload: JSON.parse(data),
					to: targets.map((t) => t.userId),
				}),
			matchKick: (targets: nkruntime.Presence[]) =>
				kicked.push(...targets.map((t) => t.userId)),
			matchLabelUpdate: () => {},
		} as unknown as nkruntime.MatchDispatcher
		return {
			fake,
			nk,
			sent,
			kicked,
			dispatcher,
			mctx: { ...playerCtx(''), matchId: 'm1' },
			state: {
				lobby,
				presences: { ann: presence('ann'), bob: presence('bob') },
				pendingInfo: {},
				label: '',
			},
		}
	}
	function loop(
		w: World,
		messages: nkruntime.MatchMessage[] = [],
		logger: nkruntime.Logger = fakeLogger,
		state: LobbyMatchState = w.state,
	): LobbyMatchState {
		const next = lobbyMatchLoop(
			w.mctx,
			logger,
			w.nk,
			w.dispatcher,
			1,
			state,
			messages,
		)
		if (next === null) throw new Error('the match ended')
		return next.state
	}
	const messageOf = (
		userId: string,
		opCode: number,
		data: string,
	): nkruntime.MatchMessage =>
		({
			sender: presence(userId),
			opCode,
			data,
		}) as unknown as nkruntime.MatchMessage
	const views = (sent: { op: number; to: string[] }[]) =>
		sent.filter((s) => s.op === ServerOp.VIEW)
	const keysOf = (w: World, collection: string) =>
		[...w.fake.objects.keys()].filter((k) => k.startsWith(`${collection}/`))
	const warning = () => {
		const warn = vi.fn()
		return {
			warn,
			logger: { ...fakeLogger, warn } as unknown as nkruntime.Logger,
		}
	}

	it('sends each player a view, then only the views that changed', () => {
		const w = world(startedPvp())
		vi.spyOn(Date, 'now').mockReturnValue(NOW)
		const first = loop(w)
		expect(
			views(w.sent)
				.flatMap((v) => v.to)
				.sort(),
		).toEqual(['ann', 'bob'])
		w.sent.length = 0
		loop(w, [], fakeLogger, first)
		expect(views(w.sent)).toEqual([])
	})

	it('sends no view in a lobby of another mod', () => {
		const w = world(speedrunLobby())
		loop(w)
		expect(views(w.sent)).toEqual([])
	})

	it("reads op 8 as the sender's input and logs what the mod refuses", () => {
		const w = world(startedPvp())
		const { warn, logger } = warning()
		const message = messageOf(
			'ann',
			ClientOp.INPUT,
			JSON.stringify({ type: 'no_such_input' }),
		)
		loop(w, [message], logger)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('refused'),
			'ABC123',
			'input',
			'ann',
			expect.any(String),
		)
	})

	it('drops op 8 in a lobby of another mod', () => {
		const w = world(speedrunLobby())
		const { warn, logger } = warning()
		loop(w, [messageOf('ann', ClientOp.INPUT, '{}')], logger)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('dropped op'),
			'ABC123',
			ClientOp.INPUT,
			'ann',
		)
	})

	describe('a ranked player who leaves before the run is built', () => {
		const draftDone: DraftResult = { kind: 'draft', survivors: [], banned: [] }
		const withoutBob = (lobby: Lobby): Lobby => ({
			...lobby,
			players: lobby.players.filter((p) => p.id !== 'bob'),
		})
		const withDraft = (lobby: Lobby): Lobby => ({
			...lobby,
			game: {
				...lobby.game,
				setup: { open: null, results: { draft: draftDone } },
			},
		})
		const storedRuns = (w: World) =>
			keysOf(w, RUNS_COLLECTION).map((k) =>
				JSON.stringify(w.fake.objects.get(k)),
			)
		const writtenCollections = (w: World) =>
			[
				...new Set([...w.fake.objects.keys()].map((k) => k.split('/')[0])),
			].sort()
		const RUN_SAVE_WRITES = [
			RUNS_COLLECTION,
			'match_logs',
			'mirror_outbox',
			'my_runs',
			'server_config',
		].sort()

		it('the run is built by the loop once Setup is over', () => {
			const ranked = startedPvp({ rankedMode: 'pvp_ranked_vanilla' })
			expect(ranked.game.pvp?.run).toBeNull()
			const w = world(withDraft(ranked))
			const next = loop(w)
			expect(next.lobby.game.pvp?.run).not.toBeNull()
			expect(next.lobby.game.pvp?.result).toBeNull()
		})

		it('leaving while Setup is open stores the run abandoned, with no placements and no other write', () => {
			const ranked = startedPvp({ rankedMode: 'pvp_ranked_vanilla' })
			const w = world(withoutBob(ranked))
			const next = loop(w)
			expect(next.lobby.game.started).toBeNull()
			const runs = storedRuns(w)
			expect(runs).toHaveLength(1)
			expect(runs[0]).toContain('"status":"abandoned"')
			expect(runs[0]).toContain('"placements":[]')
			expect(writtenCollections(w)).toEqual(RUN_SAVE_WRITES)
		})

		it('leaving as Setup finishes stores the run abandoned, not a rated win for the other player', () => {
			const ranked = startedPvp({ rankedMode: 'pvp_ranked_vanilla' })
			const w = world(withoutBob(withDraft(ranked)))
			const next = loop(w)
			expect(next.lobby.game.started).toBeNull()
			const runs = storedRuns(w)
			expect(runs).toHaveLength(1)
			expect(runs[0]).toContain('"status":"abandoned"')
			expect(writtenCollections(w)).toEqual(RUN_SAVE_WRITES)
		})
	})

	it('builds the next game when a seed vote has passed, with nobody as host', () => {
		const lobby = startedPvp()
		const pvp = lobby.game.pvp as State
		const voted: Lobby = {
			...lobby,
			game: { ...lobby.game, pvp: { ...pvp, result: { kind: 'restarted' } } },
		}
		const w = world(voted)
		const after = loop(w).lobby
		expect(after.game.started?.runId).not.toBe(lobby.game.started?.runId)
		expect(after.game.pvp?.result).toBeNull()
		expect(after.game.pvp?.run).not.toBeNull()
		expect(
			w.sent.some(
				(s) =>
					s.op === ServerOp.ACTION &&
					(s.payload as { action: string }).action === 'mpapi_restart_game',
			),
		).toBe(true)
		expect(keysOf(w, RUNS_COLLECTION)).toHaveLength(1)
	})

	it('sends a returning player below the minimum version away and keeps the seat as it was', () => {
		const away = disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby
		const w = world(away)
		writeConfig(w.nk, { ...CONFIG, pvpMinVersion: '1.0.9' })
		const back = presence('bob', 'bob-s2')
		const state: LobbyMatchState = {
			...w.state,
			presences: { ann: presence('ann'), bob: back },
			pendingInfo: { bob: info('1.0.5') },
		}
		const joined = lobbyMatchJoin(
			w.mctx,
			fakeLogger,
			w.nk,
			w.dispatcher,
			1,
			state,
			[back],
		)
		expect(w.kicked).toEqual(['bob'])
		expect(w.sent).toContainEqual({
			op: ServerOp.ERROR,
			payload: { message: 'pvp_update_required' },
			to: ['bob'],
		})
		const seat = joined?.state.lobby.players.find((p) => p.id === 'bob')
		expect(seat?.awaySince).toBe(3000)
	})

	it('gates a returning player on the version of the session joining, not on the seat', () => {
		const seated = startedPvp()
		const old: Lobby = {
			...seated,
			players: seated.players.map((p) =>
				p.id === 'bob' ? { ...p, info: info('1.0.9') } : p,
			),
		}
		const w = world(disconnect(old, 'bob', 'bob-s1', 3000).lobby)
		writeConfig(w.nk, { ...CONFIG, pvpMinVersion: '1.0.9' })
		const back = presence('bob', 'bob-s2')
		const joined = lobbyMatchJoin(
			w.mctx,
			fakeLogger,
			w.nk,
			w.dispatcher,
			1,
			{
				...w.state,
				presences: { ann: presence('ann'), bob: back },
				pendingInfo: { bob: info('1.0.5') },
			},
			[back],
		)
		expect(w.kicked).toEqual(['bob'])
		expect(w.sent).toContainEqual({
			op: ServerOp.ERROR,
			payload: { message: 'pvp_update_required' },
			to: ['bob'],
		})
		const seat = joined?.state.lobby.players.find((p) => p.id === 'bob')
		expect(seat?.awaySince).toBe(3000)
		expect(seat?.sessionId).toBe('bob-s1')
		expect(seat?.info.pvpVersion).toBe('1.0.9')
	})

	it.each([
		['the setting is empty', ''],
		['the setting is set, and the seated players are below it', '1.0.9'],
	])(
		'sends a newcomer below the minimum version away from a lobby the players referee (%s)',
		(_name, rules) => {
			const w = world(readyLobby(PVP_MOD_ID))
			writeConfig(w.nk, {
				...CONFIG,
				pvpServerRulesVersion: rules,
				pvpMinVersion: '1.0.5',
			})
			const newcomer = presence('cy')
			const joined = lobbyMatchJoin(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{
					...w.state,
					presences: { ...w.state.presences, cy: newcomer },
					pendingInfo: { cy: info('1.0.4') },
				},
				[newcomer],
			)
			expect(w.kicked).toEqual(['cy'])
			expect(w.sent).toContainEqual({
				op: ServerOp.ERROR,
				payload: { message: 'pvp_update_required' },
				to: ['cy'],
			})
			expect(joined?.state.lobby.players.map((p) => p.id)).toEqual([
				'ann',
				'bob',
			])
		},
	)

	it('sends a rejoining player one whole view when nothing has changed', () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW)
		const w = world(startedPvp())
		const first = loop(w)
		w.sent.length = 0
		const second = presence('bob', 'bob-s2')
		lobbyMatchJoin(
			w.mctx,
			fakeLogger,
			w.nk,
			w.dispatcher,
			1,
			{
				...first,
				pendingInfo: { bob: info('1.0.5') },
			},
			[second],
		)
		expect(views(w.sent).filter((v) => v.to.includes('bob'))).toHaveLength(1)
	})

	it('reads the last item of a joining player from its join message', () => {
		const away = disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby
		const w = world(away)
		const runId = String(away.game.pvp?.run?.id)
		const state: LobbyMatchState = {
			...w.state,
			presences: { ann: presence('ann') },
			pendingInfo: { bob: info('1.0.5') },
			pendingJoinKeys: { bob: { pvp_inbox_done: '0', pvp_run: runId } },
		}
		const joined = lobbyMatchJoin(
			w.mctx,
			fakeLogger,
			w.nk,
			w.dispatcher,
			1,
			state,
			[presence('bob')],
		)
		expect(w.kicked).toEqual([])
		expect(joined?.state.pendingJoinKeys).toEqual({})
		expect(views(w.sent).flatMap((v) => v.to)).toContain('bob')
	})

	it('sends a joining player their view once, not again on the next tick', () => {
		const away = disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby
		const w = world(away)
		const runId = String(away.game.pvp?.run?.id)
		const state: LobbyMatchState = {
			...w.state,
			presences: { ann: presence('ann') },
			pendingInfo: { bob: info('1.0.5') },
			pendingJoinKeys: { bob: { pvp_inbox_done: '0', pvp_run: runId } },
		}
		vi.spyOn(Date, 'now').mockReturnValue(NOW)
		const joined = lobbyMatchJoin(
			w.mctx,
			fakeLogger,
			w.nk,
			w.dispatcher,
			1,
			state,
			[presence('bob')],
		)
		if (joined === null) throw new Error('the join was refused')
		expect(views(w.sent).filter((v) => v.to.includes('bob'))).toHaveLength(1)
		w.sent.length = 0
		loop(w, [], fakeLogger, joined.state)
		expect(views(w.sent).filter((v) => v.to.includes('bob'))).toEqual([])
	})

	const errorLog = () => {
		const error = vi.fn()
		return {
			error,
			logger: { ...fakeLogger, error } as unknown as nkruntime.Logger,
		}
	}
	const boom = () => {
		throw new Error('boom')
	}
	const actionMessage = (
		from: string,
		key: string,
		params: unknown,
		to = 'server',
	) =>
		messageOf(
			from,
			ClientOp.ACTION,
			JSON.stringify({ cid: `${key}-${from}`, action: key, to, params }),
		)

	it('runs a Draft to a started run, and both players are sent a view of it', () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW)
		const w = world(startedPvp({ rankedMode: 'pvp_ranked_vanilla' }))
		let state = loop(w, [
			actionMessage('ann', 'mpapi_setup_draft', {
				id: 'draft',
				candidates: [{ key: 'a' }, { key: 'b' }],
				keep: 1,
			}),
		])
		for (let turn = 0; turn < 4 && state.lobby.game.pvp?.run === null; turn++) {
			const open = state.lobby.game.setup?.open
			if (!open || open.kind !== 'draft') break
			const actor = draftActor(open)
			if (actor === null) break
			state = loop(
				w,
				[actionMessage(actor, 'mpapi_setup_choose', { key: open.pool[0].key })],
				fakeLogger,
				state,
			)
		}
		expect(state.lobby.game.pvp?.run).not.toBeNull()
		expect([...new Set(views(w.sent).flatMap((v) => v.to))].sort()).toEqual([
			'ann',
			'bob',
		])
	})

	describe('a lobby with hooks', () => {
		const relayed = (lobby: Lobby, to: string) =>
			action(
				lobby,
				'ann',
				{ cid: 'c1', action: 'some_key', to, params: { n: 1 } },
				ctx(2000, CONFIG),
			)
		const reaching = (step: Step) =>
			step.out.filter((o) => o.kind === 'send' && o.op === ServerOp.ACTION)

		it.each([['bob'], ['*']])(
			'refuses a player-to-player action sent to %s, and relays nothing',
			(to) => {
				const step = relayed(startedPvp(), to)
				expect(rejectionOf(step)).toBe('server_referee')
				expect(step.refused).toEqual({
					key: 'some_key',
					reason: 'server_referee',
				})
				expect(reaching(step)).toEqual([])
			},
		)

		it('logs the refusal in the match loop', () => {
			const w = world(startedPvp())
			const { warn, logger } = warning()
			loop(w, [actionMessage('ann', 'some_key', {}, 'bob')], logger)
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('refused'),
				'ABC123',
				'some_key',
				'ann',
				'server_referee',
			)
			expect(w.sent.filter((s) => s.op === ServerOp.ACTION)).toEqual([])
		})

		it.each([
			['bob', ['bob']],
			['*', ['ann', 'bob']],
		])('still relays to %s in another mod', (to, targets) => {
			const lobby = speedrunLobby()
			const step = relayed(lobby, to)
			expect(rejectionOf(step)).toBeUndefined()
			expect(reaching(step)).toMatchObject([
				{ to: targets, payload: { action: 'some_key', from: 'ann' } },
			])
		})
	})

	describe('the rules setting read by the loop', () => {
		const countingReads = (w: World): { reads: () => number } => {
			let reads = 0
			const read = w.fake.storageRead
			w.fake.storageRead = (list: unknown[]) => {
				reads += 1
				return read(list)
			}
			return { reads: () => reads }
		}

		it('reads the config at most once per refresh while a PvP lobby idles, not on every tick', () => {
			const ticks = 50
			const w = world(readyLobby(PVP_MOD_ID))
			const counted = countingReads(w)
			let state = w.state
			for (let i = 0; i < ticks; i++) {
				vi.spyOn(Date, 'now').mockReturnValue(NOW + i * 200)
				state = loop(w, [], fakeLogger, state)
			}
			// 10 s of ticks: the first read plus one refresh.
			expect(counted.reads()).toBeLessThanOrEqual(3)
		})

		it('reads nothing in a lobby of another mod', () => {
			const w = world(speedrunLobby())
			const counted = countingReads(w)
			let state = w.state
			for (let i = 0; i < 10; i++) {
				vi.spyOn(Date, 'now').mockReturnValue(NOW + i * 200)
				state = loop(w, [], fakeLogger, state)
			}
			expect(counted.reads()).toBe(0)
		})
	})

	describe('an input after a server game ended', () => {
		it('is taken once the setting is off, as its view is still sent', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			const ended = {
				...readyLobby(PVP_MOD_ID),
				game: { ...emptyGame(), ended: startedPvp().game.pvp },
			}
			const w = world(ended)
			writeConfig(w.nk, { ...CONFIG, pvpServerRulesVersion: '' })
			const input = {
				kind: 'lobbyReady',
				messageNumber: 1,
				inboxDone: 0,
				runId: null,
				ready: true,
			}
			const next = loop(w, [
				messageOf('bob', ClientOp.INPUT, JSON.stringify(input)),
			])
			expect(next.lobby.messageNumbers?.bob).toBe(1)
		})
	})

	describe('a mod hook that throws', () => {
		it('drops the input, logs it, and keeps the lobby', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			vi.spyOn(pvpHooks, 'onInput').mockImplementation(boom)
			const w = world(startedPvp())
			const { error, logger } = errorLog()
			const next = loop(
				w,
				[messageOf('ann', ClientOp.INPUT, JSON.stringify({ type: 'x' }))],
				logger,
			)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'a message',
				expect.anything(),
			)
			expect(next.lobby.game.started?.runId).toBe('run-2')
		})

		it('skips the tick step of onTick, logs it, and keeps the lobby', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			vi.spyOn(pvpHooks, 'onTick').mockImplementation(boom)
			const w = world(startedPvp())
			const { error, logger } = errorLog()
			const next = loop(w, [], logger)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'onTick',
				expect.anything(),
			)
			expect(next.lobby.game.pvp).toEqual(w.state.lobby.game.pvp)
		})

		it('sends no views when views throws, logs it, and keeps the lobby', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			vi.spyOn(pvpHooks, 'views').mockImplementation(boom)
			const w = world(startedPvp())
			const { error, logger } = errorLog()
			const next = loop(w, [], logger)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'views',
				expect.anything(),
			)
			expect(views(w.sent)).toEqual([])
			expect(next.lobby.game.started?.runId).toBe('run-2')
		})

		it('keeps the Setup results when startRunWhenSetupDone throws, and logs it', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			vi.spyOn(pvpHooks, 'startRunWhenSetupDone').mockImplementation(boom)
			const ranked = startedPvp({ rankedMode: 'pvp_ranked_vanilla' })
			const w = world({
				...ranked,
				game: {
					...ranked.game,
					setup: {
						open: null,
						results: { draft: { kind: 'draft', survivors: [], banned: [] } },
					},
				},
			})
			const { error, logger } = errorLog()
			const next = loop(w, [], logger)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'startRunWhenSetupDone',
				expect.anything(),
			)
			expect(next.lobby.game.started?.runId).toBe('run-2')
			expect(next.lobby.game.pvp?.run).toBeNull()
		})

		it('sends the session away and keeps the seat when onJoin throws, and logs it', () => {
			vi.spyOn(pvpHooks, 'onJoin').mockImplementation(boom)
			const away = disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby
			const w = world(away)
			const { error, logger } = errorLog()
			const back = presence('bob', 'bob-s2')
			const joined = lobbyMatchJoin(
				w.mctx,
				logger,
				w.nk,
				w.dispatcher,
				1,
				{
					...w.state,
					presences: { ann: presence('ann'), bob: back },
					pendingInfo: { bob: info('1.0.5') },
				},
				[back],
			)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'onJoin',
				expect.anything(),
			)
			expect(w.kicked).toEqual(['bob'])
			expect(w.sent).toContainEqual({
				op: ServerOp.ERROR,
				payload: { message: 'hook_failed' },
				to: ['bob'],
			})
			const seat = joined?.state.lobby.players.find((p) => p.id === 'bob')
			expect(seat?.awaySince).toBe(3000)
		})

		it('keeps the game when ending throws, and logs it', () => {
			const lobby = startedPvp()
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			vi.spyOn(pvpHooks, 'ending').mockImplementation(boom)
			const w = world(lobby)
			const { error, logger } = errorLog()
			const next = loop(w, [], logger)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('threw'),
				'ABC123',
				'ending',
				expect.anything(),
			)
			expect(next.lobby.game.started?.runId).toBe('run-2')
		})
	})

	describe('a mod ending when the lobby closes mid-game', () => {
		const close = (w: World) =>
			lobbyMatchSignal(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				w.state,
				JSON.stringify({ type: 'admin_close' }),
			)
		const storedRun = (w: World) =>
			JSON.stringify(w.fake.objects.get(keysOf(w, RUNS_COLLECTION)[0]))

		it('stores the places the core decided, not abandoned', () => {
			const w = world(
				decided(
					startedPvp(),
					{ kind: 'win', winners: ['ann'], rating: 'rated' },
					{ ann: 1, bob: 2 },
				),
			)
			close(w)
			expect(keysOf(w, RUNS_COLLECTION)).toHaveLength(1)
			expect(storedRun(w)).toContain('agreed')
			expect(storedRun(w)).not.toContain('abandoned')
			expect(
				w.sent.filter(
					(s) =>
						s.op === ServerOp.EVENT &&
						(s.payload as { type: string }).type === 'game_ended',
				),
			).toHaveLength(1)
		})

		it('stores abandoned when the mod has not decided', () => {
			const w = world(startedPvp())
			close(w)
			expect(storedRun(w)).toContain('abandoned')
		})

		it('stores abandoned when the game was only waiting on a new seed', () => {
			const lobby = startedPvp()
			const pvp = lobby.game.pvp as State
			const w = world({
				...lobby,
				game: { ...lobby.game, pvp: { ...pvp, result: { kind: 'restarted' } } },
			})
			close(w)
			expect(storedRun(w)).toContain('abandoned')
			expect(storedRun(w)).not.toContain('restarted')
		})
	})

	describe('a mod hook that keeps throwing', () => {
		const stuck = (throwsOn: (call: number) => boolean) => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			let calls = 0
			vi.spyOn(pvpHooks, 'onTick').mockImplementation((lobby) => {
				calls += 1
				if (throwsOn(calls)) throw new Error('boom')
				return lobby
			})
		}
		const endedEvents = (w: World) =>
			w.sent.filter(
				(s) =>
					s.op === ServerOp.EVENT &&
					(s.payload as { type: string }).type === 'game_ended',
			)
		const gaveUp = (error: ReturnType<typeof vi.fn>) =>
			error.mock.calls.filter((call) => String(call[0]).includes('abandon'))

		it('lets the game go on when a success comes at least every tenth call', () => {
			stuck((call) => call % 10 !== 0)
			const w = world(startedPvp())
			const { error, logger } = errorLog()
			let state = w.state
			for (let at = 0; at < 35; at++) state = loop(w, [], logger, state)
			expect(state.lobby.game.started).not.toBeNull()
			expect(gaveUp(error)).toEqual([])
		})

		it('abandons the game once after ten throws in a row, and logs it once', () => {
			stuck(() => true)
			const w = world(startedPvp())
			const { error, logger } = errorLog()
			let state = w.state
			for (let at = 0; at < 9; at++) state = loop(w, [], logger, state)
			expect(state.lobby.game.started).not.toBeNull()
			state = loop(w, [], logger, state)
			expect(state.lobby.game.started).toBeNull()
			for (let at = 0; at < 3; at++) state = loop(w, [], logger, state)
			expect(keysOf(w, RUNS_COLLECTION)).toHaveLength(1)
			expect(
				JSON.stringify(w.fake.objects.get(keysOf(w, RUNS_COLLECTION)[0])),
			).toContain('abandoned')
			expect(endedEvents(w)).toHaveLength(1)
			expect(gaveUp(error)).toHaveLength(1)
		})
	})

	describe('a restart the mod cannot build', () => {
		it('stores the game abandoned once and announces it, with no retry on the next tick', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			const lobby = startedPvp()
			const pvp = lobby.game.pvp as State
			const w = world({
				...lobby,
				metadata: {},
				game: { ...lobby.game, pvp: { ...pvp, result: { kind: 'restarted' } } },
			})
			const { error, logger } = errorLog()
			const next = loop(w, [], logger)
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining('could not restart'),
				'ABC123',
				expect.any(String),
			)
			expect(next.lobby.game.started).toBeNull()
			expect(keysOf(w, RUNS_COLLECTION)).toHaveLength(1)
			expect(
				JSON.stringify(w.fake.objects.get(keysOf(w, RUNS_COLLECTION)[0])),
			).toContain('abandoned')
			const ended = () =>
				w.sent.filter(
					(s) =>
						s.op === ServerOp.EVENT &&
						(s.payload as { type: string }).type === 'game_ended',
				)
			expect(ended()).toHaveLength(1)
			loop(w, [], logger, next)
			expect(keysOf(w, RUNS_COLLECTION)).toHaveLength(1)
			expect(ended()).toHaveLength(1)
		})
	})

	describe('the views of a lobby with hooks', () => {
		it('asks the mod for views once on a quiet tick', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			const w = world(startedPvp())
			const first = loop(w)
			const spy = vi.spyOn(pvpHooks, 'views')
			loop(w, [], fakeLogger, first)
			expect(spy).toHaveBeenCalledTimes(1)
		})

		it('forgets the views of a player who is no longer in the lobby', () => {
			vi.spyOn(Date, 'now').mockReturnValue(NOW)
			const w = world(startedPvp())
			const first = loop(w)
			const lastViewSent = first.lastViewSent ?? {}
			expect(Object.keys(lastViewSent).sort()).toEqual(['ann', 'bob'])
			const stale: LobbyMatchState = {
				...first,
				lastViewSent: { ...lastViewSent, zed: lastViewSent.ann },
			}
			expect(
				Object.keys(loop(w, [], fakeLogger, stale).lastViewSent ?? {}).sort(),
			).toEqual(['ann', 'bob'])
		})
	})

	describe('a join that carries the last item', () => {
		const attempt = (w: World, metadata: { [key: string]: string }) => {
			const back = presence('bob', 'bob-s2')
			w.fake.accountGetId = () => ({})
			const tried = lobbyMatchJoinAttempt(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{ ...w.state, presences: { ann: presence('ann') } },
				back,
				{ modId: PVP_MOD_ID, ...metadata },
			)
			expect(tried.accept).toBe(true)
			return lobbyMatchJoin(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{
					...tried.state,
					presences: { ann: presence('ann'), bob: back },
				},
				[back],
			)
		}

		it('reads a number of several digits, for another run', () => {
			const w = world(disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby)
			attempt(w, { pvp_run: 'another-run', pvp_inbox_done: '12' })
			expect(w.kicked).toEqual([])
		})

		it('passes the join keys from the attempt to the join: a number past the inbox is refused', () => {
			const w = world(disconnect(startedPvp(), 'bob', 'bob-s1', 3000).lobby)
			attempt(w, {
				pvp_run: String(w.state.lobby.game.pvp?.run?.id),
				pvp_inbox_done: '999999',
			})
			expect(w.kicked).toEqual(['bob'])
			expect(w.sent).toContainEqual({
				op: ServerOp.ERROR,
				payload: { message: 'bad_params' },
				to: ['bob'],
			})
		})
	})

	describe('a second session of the same player', () => {
		it('is told the account opened elsewhere and kicks it', () => {
			const w = world(startedPvp())
			const second = presence('bob', 'bob-s2')
			const joined = lobbyMatchJoin(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{
					...w.state,
					pendingInfo: { bob: info('1.0.5') },
				},
				[second],
			)
			expect(w.kicked).toEqual(['bob'])
			expect(w.sent).toContainEqual({
				op: ServerOp.EVENT,
				payload: expect.objectContaining({
					type: 'player_kicked',
					playerId: 'bob',
					data: { kickedBy: 'server', reason: 'opened_elsewhere' },
				}),
				to: ['bob'],
			})
			expect(joined?.state.presences.bob.sessionId).toBe('bob-s2')
		})

		it('leaves the first session and the seat as they were when the join is refused', () => {
			const w = world(startedPvp())
			const kickedSessions: string[] = []
			w.dispatcher.matchKick = (targets) => {
				kickedSessions.push(...targets.map((t) => t.sessionId))
			}
			const second = presence('bob', 'bob-s2')
			const joined = lobbyMatchJoin(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{
					...w.state,
					pendingInfo: { bob: info('1.0.5') },
					pendingJoinKeys: {
						bob: {
							pvp_inbox_done: '999999',
							pvp_run: String(w.state.lobby.game.pvp?.run?.id),
						},
					},
				},
				[second],
			)
			expect(kickedSessions).toEqual(['bob-s2'])
			expect(w.sent.filter((s) => s.op === ServerOp.EVENT)).toEqual([])
			expect(joined?.state.presences.bob.sessionId).toBe('bob-s1')
			const seat = joined?.state.lobby.players.find((p) => p.id === 'bob')
			expect(seat?.sessionId).toBe('bob-s1')
			expect(seat?.awaySince).toBeNull()
		})

		it('keeps the new session and the seat when the first one then leaves', () => {
			const w = world(startedPvp())
			const joined = lobbyMatchJoin(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				{
					...w.state,
					pendingInfo: { bob: info('1.0.5') },
				},
				[presence('bob', 'bob-s2')],
			)
			if (joined === null) throw new Error('the join was refused')
			const left = lobbyMatchLeave(
				w.mctx,
				fakeLogger,
				w.nk,
				w.dispatcher,
				1,
				joined.state,
				[presence('bob')],
			)
			expect(left?.state.presences.bob.sessionId).toBe('bob-s2')
			expect(
				left?.state.lobby.players.find((p) => p.id === 'bob')?.awaySince,
			).toBeNull()
		})

		it('sends nothing when the same session joins again, or in another mod', () => {
			const w = world(startedPvp())
			lobbyMatchJoin(w.mctx, fakeLogger, w.nk, w.dispatcher, 1, w.state, [
				presence('bob'),
			])
			const other = world(speedrunLobby())
			lobbyMatchJoin(
				other.mctx,
				fakeLogger,
				other.nk,
				other.dispatcher,
				1,
				other.state,
				[presence('bob', 'bob-s2')],
			)
			expect(w.kicked).toEqual([])
			expect(other.kicked).toEqual([])
		})
	})
})

describe('a PvP lobby loaded from its checkpoint', () => {
	const checkpointOf = (lobby: Lobby): Checkpoint => ({
		lobby,
		at: NOW,
		claimedAt: null,
	})
	it('tells the match how long the server was down', () => {
		const lobby = startedPvp()
		const resumed = resumeFrom(checkpointOf(lobby), NOW + 7000)
		expect(resumed.game.pvp).toEqual(resumeState(lobby.game.pvp as State, 7000))
	})

	it('leaves a lobby of another mod as it was', () => {
		const lobby = send(
			readyLobby('MultiplayerSPDRN'),
			'ann',
			'mpapi_start_game',
			{ stake: 1 },
			1000,
		).lobby
		expect(resumeFrom(checkpointOf(lobby), NOW + 7000).game.pvp).toBeUndefined()
	})
})

describe('the version gate of a PvP match', () => {
	const report = (fake: FakeNk, userId: string, version: string) =>
		writeModReport(fake as unknown as nkruntime.Nakama, userId, {
			mods: [`${PVP_MOD_ID}-${version}`],
			reportedAt: 0,
		})

	it('refuses a player below the minimum even when everyone runs that version', () => {
		const fake = fakeNk()
		const nk = fake as unknown as nkruntime.Nakama
		writeConfig(nk, { ...DEFAULT_CONFIG, pvpMinVersion: '1.0.5' })
		report(fake, 'a', '1.0.4')
		report(fake, 'b', '1.0.4')
		expect(Object.keys(pvpVersionRefusals(nk, ['a', 'b'])).sort()).toEqual([
			'a',
			'b',
		])
	})

	it('has no minimum when the config has none', () => {
		const fake = fakeNk()
		report(fake, 'a', '1.0.4')
		report(fake, 'b', '1.0.4')
		expect(
			pvpVersionRefusals(fake as unknown as nkruntime.Nakama, ['a', 'b']),
		).toEqual({})
	})
})
