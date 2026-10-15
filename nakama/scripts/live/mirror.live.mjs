// Live: finished games reach Nakama storage and, through Express's mirror job,
// Postgres (lobby_runs, match_run_logs, matchmaking_matches,
// matchmaking_ratings, match_result_conflicts, service_queue). Two/three
// throwaway device-auth clients play games the way MPAPI does: ready, start,
// mpapi_log_event (ending in a 'chk' hash), mpapi_report_result.
// Run: node nakama/scripts/live/mirror.live.mjs
import { pathToFileURL } from 'node:url'
import {
	PREFIX,
	admin,
	check,
	connect,
	deviceAuth,
	lobbyWith,
	poll,
	psql,
	q,
	rpc,
	sendLog,
	sleep,
	startGame,
	summary,
} from './lib.mjs'

const MOD = PREFIX + 'mod'
export const outputs = {}

async function player(name) {
	const p = await deviceAuth(name)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await rpc(p.token, 'session_init', { steamName: p.username })
	p.socket = await connect(p)
	return p
}

// Queues every player for the same matchmade game and joins it.
export async function matchmake(players, mode, kind = 'casual') {
	const query = `+properties.modId:${MOD} +properties.mode:${mode} +properties.kind:${kind}`
	const marks = players.map((p) => p.socket.mark())
	for (const p of players) {
		const t = await p.socket.request({
			matchmaker_add: {
				min_count: players.length,
				max_count: players.length,
				query,
				string_properties: { modId: MOD, mode, kind },
			},
		})
		if (!t.matchmaker_ticket) throw new Error('matchmaker_add: ' + JSON.stringify(t))
	}
	const matched = await Promise.all(players.map((p, i) => p.socket.waitFor((x) => x.kind === 'matched', 20000, marks[i])))
	if (matched.some((m) => !m || !m.match_id)) throw new Error('not matched: ' + JSON.stringify(matched))
	const matchId = matched[0].match_id
	for (const p of players) {
		const j = await p.socket.join(matchId, { modId: MOD, displayName: p.username })
		if (j.error) throw new Error('join: ' + JSON.stringify(j.error))
		await p.socket.waitFor((x) => x.kind === 'data' && x.op === 100, 5000)
	}
	const code = psql('nakama', `select key from storage where collection='lobby_codes' and value->>'matchId'=${q(matchId)}`)
	return { matchId, code: code.length ? code[0][0] : null }
}

// A matchmade lobby is hosted by whoever arrived first: host first, then the rest.
export async function hostFirst(code, players) {
	const view = await admin('admin_lobby_get', { code })
	const hostId = view.body.lobby.hostId
	return players.filter((p) => p.userId === hostId).concat(players.filter((p) => p.userId !== hostId))
}

const placementsOf = (order) => order.map((p, i) => ({ playerId: p.userId, place: i + 1 }))

async function waitEnded(p, since, timeoutMs = 10000) {
	return p.socket.waitFor((x) => x.kind === 'data' && x.op === 101 && x.data.type === 'game_ended', timeoutMs, since)
}

function lobbyRun(runId) {
	return psql('bmp', `select status, lobby_type, matchmaking_match_id, mod_id from lobby_runs where id=${q(runId)}`)
}

async function mirrored(runId) {
	return poll(() => lobbyRun(runId).length > 0, 30000)
}

function pgPlayer(nakamaUserId) {
	const r = psql('bmp', `select id from players where nakama_user_id=${q(nakamaUserId)}`)
	return r.length ? r[0][0] : null
}

async function main() {
	const [p1, p2, p3] = [await player('mir_1'), await player('mir_2'), await player('mir_3')]

	// --- A: private lobby, agreed, one tampered log ----------------------------
	const lob = await lobbyWith([p1, p2], { modId: MOD })
	const started = await startGame([p1, p2], { stake: 1, options: { h1: true } })
	check('A: game started with a server seed', typeof started.seed === 'string' && started.seed.length === 8, JSON.stringify(started).slice(0, 160))
	const runA = started.runId
	await sendLog(p1.socket, runA, [[1, 'start', { deck: 'b_red' }], [2, 'blind', ['bl_small']], [3, 'end', { won: true }]])
	await sendLog(p2.socket, runA, [[1, 'start', { deck: 'b_blue' }], [2, 'blind', ['bl_small']]], { tamper: true })
	// A stale-run event (another run id) is dropped, not logged.
	p1.socket.action('mpapi_log_event', { t: 50, opcode: 'stale', args: null, run: 'not-this-run' })
	await sleep(500)
	let since = p1.socket.mark()
	const r1 = await p1.socket.ask('mpapi_report_result', { placements: placementsOf([p1, p2]) })
	check('A: host report accepted', r1.ok, JSON.stringify(r1))
	const r2 = await p2.socket.ask('mpapi_report_result', { placements: placementsOf([p1, p2]) })
	check('A: guest report accepted', r2.ok, JSON.stringify(r2))
	const endedA = await waitEnded(p1, since)
	check('A: GAME_ENDED status agreed', endedA && endedA.data.data.status === 'agreed', endedA && JSON.stringify(endedA.data.data))

	const runRec = psql('nakama', `select value from storage where collection='match_runs' and key=${q(runA)}`)
	const run = runRec.length ? JSON.parse(runRec[0][0]) : null
	check('A: match_runs record stored', run && run.status === 'agreed' && run.lobbyType === 'private', run && JSON.stringify({ status: run.status, flags: run.flags }))
	check('A: tampered log flagged hash_mismatch, honest one not', run && run.flags && run.flags[p2.userId] === 'hash_mismatch' && !run.flags[p1.userId], run && JSON.stringify(run.flags))
	const logs = psql('nakama', `select key, value->>'check', value->>'eventCount' from storage where collection='match_logs' and key like ${q(runA + ':%')}`)
	check(
		'A: match_logs: p1 match (4 events, stale one dropped), p2 mismatch',
		logs.some((l) => l[0].endsWith(p1.userId) && l[1] === 'match' && l[2] === '4') && logs.some((l) => l[0].endsWith(p2.userId) && l[1] === 'mismatch'),
		JSON.stringify(logs.map((l) => [l[0].slice(-6), l[1], l[2]])),
	)
	const mine = psql('nakama', `select user_id from storage where collection='my_runs' and key like ${q('%:' + runA)}`)
	check('A: my_runs pointer per participant', mine.length === 2, JSON.stringify(mine))
	const runsMine = await rpc(p1.token, 'runs_mine', {})
	check('A: runs_mine lists the run', runsMine.ok && JSON.stringify(runsMine.body).includes(runA), runsMine.text.slice(0, 160))
	const runGet = await rpc(p3.token, 'run_get', { runId: runA })
	console.log(`  info: run_get by a non-participant -> ${runGet.status} ${runGet.text.slice(0, 120)}`)
	const runLogs = await rpc(p3.token, 'run_logs', { runId: runA })
	console.log(`  info: run_logs by a non-participant -> ${runLogs.status} ${runLogs.text.slice(0, 120)}`)

	check('A: mirrored into lobby_runs', await mirrored(runA))
	const lr = lobbyRun(runA)[0]
	check('A: lobby_runs completed/private/no match', lr[0] === 'completed' && lr[1] === 'private' && lr[2] === '', JSON.stringify(lr))
	const mrl = psql('bmp', `select player_id, status, flag_reason, event_count, expires_at is null from match_run_logs where run_id=${q(runA)}`)
	const pg1 = pgPlayer(p1.userId)
	const pg2 = pgPlayer(p2.userId)
	check('A: players rows linked to the Nakama users', !!pg1 && !!pg2)
	check(
		'A: match_run_logs: p1 complete/no flag/expires, p2 flagged hash_mismatch/kept',
		mrl.length === 2 &&
			mrl.some((r) => r[0] === pg1 && r[1] === 'complete' && r[2] === '' && r[3] === '4' && r[4] === 'f') &&
			mrl.some((r) => r[0] === pg2 && r[2] === 'hash_mismatch' && r[4] === 't'),
		JSON.stringify(mrl),
	)
	const sq = await poll(() => psql('bmp', `select item_type, subject_player_id from service_queue_items where source_id=${q(runA)}`).length > 0, 10000)
	const sqRows = psql('bmp', `select item_type, subject_player_id from service_queue_items where source_id=${q(runA)}`)
	check('A: anti_cheat service-queue item for p2', sq && sqRows.length === 1 && sqRows[0][0] === 'anti_cheat' && sqRows[0][1] === pg2, JSON.stringify(sqRows))
	outputs.runA = runA
	outputs.flaggedPlayer = pg2
	outputs.honestPlayer = pg1
	// Leave the lobby so the matchmaker can seat them.
	p1.socket.sendOp(1, {})
	p2.socket.sendOp(1, {})
	await sleep(800)

	// --- B: matchmade casual, 3 players, 2-vs-1 dispute ------------------------
	const mmB = await matchmake([p1, p2, p3], PREFIX + 'cas')
	check('B: matchmade lobby made', !!mmB.code, JSON.stringify(mmB))
	const startedB = await startGame(await hostFirst(mmB.code, [p1, p2, p3]), {})
	const runB = startedB.runId
	const majority = placementsOf([p1, p2, p3])
	const minority = placementsOf([p3, p1, p2])
	since = p1.socket.mark()
	await p3.socket.ask('mpapi_report_result', { placements: minority })
	await p1.socket.ask('mpapi_report_result', { placements: majority })
	await p2.socket.ask('mpapi_report_result', { placements: majority })
	const endedB = await waitEnded(p1, since)
	check('B: 3-player 2-vs-1 is disputed, majority recorded', endedB && endedB.data.data.status === 'disputed' && JSON.stringify(endedB.data.data.placements.find((x) => x.playerId === p1.userId)) === JSON.stringify({ playerId: p1.userId, place: 1 }), endedB && JSON.stringify(endedB.data.data))
	check('B: mirrored into lobby_runs', await mirrored(runB))
	const lrB = lobbyRun(runB)[0]
	check('B: lobby_runs public with matchmaking_match_id', lrB[1] === 'public' && lrB[2] === runB, JSON.stringify(lrB))
	const mm = psql('bmp', `select game_mode, status, result_reported_by, jsonb_array_length(result_placements) from matchmaking_matches where match_id=${q(runB)}`)
	check('B: matchmaking_matches row', mm.length === 1 && mm[0][0] === PREFIX + 'cas' && mm[0][1] === 'resolved' && mm[0][3] === '3', JSON.stringify(mm))
	const conf = psql('bmp', `select first_reporter_id, conflicting_reporter_id, status from match_result_conflicts where match_id=${q(runB)}`)
	const pg3 = pgPlayer(p3.userId)
	check('B: one match_result_conflicts row against p3', conf.length === 1 && conf[0][1] === pg3 && conf[0][0] === pg1 && conf[0][2] === 'open', JSON.stringify(conf))
	const sqB = psql('bmp', `select item_type from service_queue_items where item_type='match_conflict' and source_id in (select id::text from match_result_conflicts where match_id=${q(runB)})`)
	check('B: match_conflict service-queue item', sqB.length === 1, JSON.stringify(sqB))
	outputs.runB = runB
	outputs.conflictId = psql('bmp', `select id from match_result_conflicts where match_id=${q(runB)}`)[0][0]
	for (const p of [p1, p2, p3]) p.socket.sendOp(1, {})
	await sleep(800)

	// --- C: matchmade ranked, 2 players, agreed, ratings ------------------------
	const mmC = await matchmake([p1, p2], PREFIX + 'rk', 'ranked')
	const startedC = await startGame(await hostFirst(mmC.code, [p1, p2]), {})
	const runC = startedC.runId
	since = p1.socket.mark()
	await p1.socket.ask('mpapi_report_result', { placements: placementsOf([p2, p1]) })
	await p2.socket.ask('mpapi_report_result', { placements: placementsOf([p2, p1]) })
	const endedC = await waitEnded(p1, since)
	check('C: ranked game agreed', endedC && endedC.data.data.status === 'agreed', endedC && JSON.stringify(endedC.data.data))
	const runCRec = JSON.parse(psql('nakama', `select value from storage where collection='match_runs' and key=${q(runC)}`)[0][0])
	check('C: run carries ratings for both', runCRec.ratings && runCRec.ratings[p1.userId] && runCRec.ratings[p2.userId], JSON.stringify(runCRec.ratings))
	check('C: mirrored', await mirrored(runC))
	const rt = await poll(() => {
		const r = psql('bmp', `select player_id, game_mode, games_played, wins, losses from matchmaking_ratings where player_id in (${q(pg1)},${q(pg2)}) and mod_id=${q(MOD)}`)
		return r.length === 2 ? r : null
	}, 10000)
	check(
		'C: matchmaking_ratings rows keyed ranked:<mode>, p2 won',
		rt && rt.every((r) => r[1] === 'ranked:' + PREFIX + 'rk') && rt.some((r) => r[0] === pg2 && r[3] !== '0' && r[4] === '0') && rt.some((r) => r[0] === pg1 && r[4] !== '0' && r[3] === '0'),
		JSON.stringify(rt),
	)
	for (const p of [p1, p2]) p.socket.sendOp(1, {})
	await sleep(800)

	// --- Idempotency: no duplicate rows after more mirror ticks ------------------
	await sleep(11000)
	const counts = psql(
		'bmp',
		`select (select count(*) from lobby_runs where id in (${q(runA)},${q(runB)},${q(runC)})),
		        (select count(*) from match_run_logs where run_id in (${q(runA)},${q(runB)},${q(runC)})),
		        (select count(*) from matchmaking_matches where match_id in (${q(runB)},${q(runC)})),
		        (select count(*) from match_result_conflicts where match_id=${q(runB)}),
		        (select count(*) from service_queue_items where source_id=${q(runA)})`,
	)[0]
	check('mirror rows exactly once (3 runs, 7 logs, 2 matches, 1 conflict, 1 AC item)', counts.join(',') === '3,7,2,1,1', counts.join(','))
	const outbox = await admin('admin_mirror_pull', { limit: 50 })
	const mine2 = (outbox.body.entries || []).filter((e) => e.kind === 'run' && [runA, runB, runC].includes(e.run.runId))
	check('outbox drained of these runs', outbox.ok && mine2.length === 0, `${(outbox.body.entries || []).length} entries in outbox`)
	console.log('OUTPUTS ' + JSON.stringify(outputs))
	for (const p of [p1, p2, p3]) p.socket.close()
	await sleep(300)
	process.exitCode = summary('mirror.live') ? 1 : 0
}

// Only when run directly: other scripts import matchmake/hostFirst.
if (import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((e) => {
		console.error(e)
		process.exitCode = 2
	})
