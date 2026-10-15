// Live (W5): seeds a throwaway ranked board for the global-state tests.
// Four device players play matchmade ranked games on w5test_mod/w5test_rk:
//   a vs b: 5 agreed games (a wins 4), 1 disputed game, 1 game where a's log
//           is tampered (a flagged hash_mismatch)
//   c vs d: 6 agreed games (c wins all)
// so a, b, c, d are all past their 5 placement games. Prints the Nakama and
// Postgres view of the board at the end.
// Run: BMP_TEST_PREFIX=w5test_ node nakama/scripts/live/w5-seed.live.mjs
import { PREFIX, check, connect, deviceAuth, poll, psql, q, rpc, sendLog, sleep, startGame, summary } from './lib.mjs'
import { hostFirst, matchmake } from './mirror.live.mjs'

export const MOD = PREFIX + 'mod'
export const MODE = PREFIX + 'rk'

export async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

const ended = (s, since, timeoutMs = 15000) =>
	s.waitFor((x) => x.kind === 'data' && x.op === 101 && x.data.type === 'game_ended', timeoutMs, since)

// One matchmade ranked game. `reports` maps each player to the placement
// order they report; `tamper` lists players whose log hash is wrong.
export async function rankedGame(players, reports, { tamper = [] } = {}) {
	const mm = await matchmake(players, MODE, 'ranked')
	const ordered = await hostFirst(mm.code, players)
	const started = await startGame(ordered, {})
	const runId = started.runId
	for (const p of players) {
		await sendLog(p.socket, runId, [[1, 'start', { deck: 'b_red' }], [2, 'end', {}]], { tamper: tamper.includes(p) })
	}
	await sleep(300)
	const since = players[0].socket.mark()
	for (const p of players) {
		const order = reports.get(p)
		if (!order) continue
		const r = await p.socket.ask('mpapi_report_result', { placements: order.map((x, i) => ({ playerId: x.userId, place: i + 1 })) })
		if (!r.ok) throw new Error('report failed: ' + JSON.stringify(r))
	}
	const end = await ended(players[0].socket, since)
	for (const p of players) p.socket.sendOp(1, {})
	await sleep(700)
	return { runId, code: mm.code, status: end && end.data.data.status, ratings: end && end.data.data.ratings }
}

export function nakamaBoard(season = 1) {
	return psql(
		'nakama',
		`select u.username, s.value->>'rating', s.value->>'gamesPlayed', s.value->>'wins', s.value->>'losses', s.value->>'lastMatchAt'
		 from storage s join users u on u.id = s.user_id
		 where s.collection='ratings' and s.key=${q(`${MOD}:${MODE}:${season}`)} order by 1`,
	)
}

export function pgBoard(season = 1) {
	return psql(
		'bmp',
		`select p.steam_name, r.rating, r.games_played, r.wins, r.losses, r.last_match_at
		 from matchmaking_ratings r join players p on p.id = r.player_id
		 where r.mod_id=${q(MOD)} and r.game_mode=${q('ranked:' + MODE)} and r.season=${season} order by 1`,
	)
}

async function main() {
	const [a, b, c, d] = [await player('a'), await player('b'), await player('c'), await player('d')]
	const ab = [a, b]
	const runs = []
	for (let i = 0; i < 5; i++) {
		const w = i === 2 ? b : a
		const l = w === a ? b : a
		const g = await rankedGame(ab, new Map([[a, [w, l]], [b, [w, l]]]))
		runs.push(g)
		check(`a-b game ${i + 1} agreed`, g.status === 'agreed', g.status)
	}
	const disputed = await rankedGame(ab, new Map([[a, [a, b]], [b, [b, a]]]))
	check('a-b disputed game is disputed', disputed.status === 'disputed', disputed.status)
	const flagged = await rankedGame(ab, new Map([[a, [a, b]], [b, [a, b]]]), { tamper: [a] })
	check('a-b flagged game agreed', flagged.status === 'agreed', flagged.status)
	for (let i = 0; i < 6; i++) {
		const g = await rankedGame([c, d], new Map([[c, [c, d]], [d, [c, d]]]))
		check(`c-d game ${i + 1} agreed`, g.status === 'agreed', g.status)
	}
	await poll(() => pgBoard().length === 4 && pgBoard().every((r) => Number(r[2]) >= 5), 30000)
	console.log('NAKAMA', JSON.stringify(nakamaBoard()))
	console.log('PG    ', JSON.stringify(pgBoard()))
	console.log('RUNS', JSON.stringify({ disputed: disputed.runId, flagged: flagged.runId, users: { a: a.userId, b: b.userId, c: c.userId, d: d.userId } }))
	for (const p of [a, b, c, d]) p.socket.close()
	await sleep(300)
	process.exitCode = summary('w5-seed') ? 1 : 0
}

if (process.argv[1] && process.argv[1].endsWith('w5-seed.live.mjs'))
	main().catch((e) => {
		console.error(e)
		process.exitCode = 2
	})
