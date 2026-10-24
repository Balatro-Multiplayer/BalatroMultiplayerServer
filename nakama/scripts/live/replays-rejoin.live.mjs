// Live: replay-log storage, the run RPCs and the rejoin rules. Takes ~3 minutes
// (one scenario waits out the real 120 s grace period).
//  - logs: oversized event, malformed tuples, stale-run and duplicate uploads,
//    an upload after the match ended, the 1 MB byte cap, who may read a run
//    and its logs, the mirror into Postgres (JSON -> gzip -> base64)
//  - retention: a purge drops an old run, keeps a flagged one
//  - rejoin: back within the grace with the log intact, an old session
//    replaced, two rejoins at once, another account, after the forfeit, into
//    a closed lobby
// Run: BMP_TEST_PREFIX=F5_ node nakama/scripts/live/replays-rejoin.live.mjs
import { gunzipSync } from 'node:zlib'
import {
	PREFIX,
	ServerOp,
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
	sha256Hex,
	sleep,
	startGame,
	startSession,
	summary,
} from './lib.mjs'

const stamp = Date.now().toString(36)

async function player(name) {
	const p = await deviceAuth(`rr_${stamp}_${name}`)
	if (p.error) throw new Error(`auth ${name}: ${JSON.stringify(p.error)}`)
	await startSession(p)
	p.socket = await connect(p)
	return p
}

const placementsOf = (order) => order.map((p, i) => ({ playerId: p.userId, place: i + 1 }))
const isEvent = (type) => (x) => x.kind === 'data' && x.op === ServerOp.EVENT && x.data.type === type
const logsOf = async (p, runId, extra = {}) => rpc(p.token, 'run_logs', { runId, ...extra })

async function finish(a, b, runId) {
	const since = a.socket.mark()
	await a.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
	await b.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
	return a.socket.waitFor(isEvent('game_ended'), 10000, since)
}

async function logScenario() {
	const [a, b, outsider] = [await player('la'), await player('lb'), await player('lo')]
	await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})

	// --- bad uploads: refused or dropped, never stored --------------------------
	const big = await a.socket.ask('mpapi_log_event', { t: 1, opcode: 'x', args: 'y'.repeat(17000), run: runId })
	check('log: an event over 16 KB is refused too_large', big.rejected === 'too_large', JSON.stringify(big))
	const noOpcode = await a.socket.ask('mpapi_log_event', { t: 1, run: runId })
	check('log: no opcode -> bad_params', noOpcode.rejected === 'bad_params', JSON.stringify(noOpcode))
	const strT = await a.socket.ask('mpapi_log_event', { t: '1', opcode: 'x', run: runId })
	check('log: string t -> bad_params', strT.rejected === 'bad_params', JSON.stringify(strT))
	const longOp = await a.socket.ask('mpapi_log_event', { t: 1, opcode: 'o'.repeat(65), run: runId })
	check('log: opcode over 64 chars -> bad_params', longOp.rejected === 'bad_params', JSON.stringify(longOp))
	const arr = await a.socket.ask('mpapi_log_event', [1, 'x', null])
	check('log: an array instead of an object -> bad_params', arr.rejected === 'bad_params', JSON.stringify(arr))
	const nul = await a.socket.ask('mpapi_log_event', null)
	check('log: null params -> bad_params', nul.rejected === 'bad_params', JSON.stringify(nul))
	const stale = await a.socket.ask('mpapi_log_event', { t: 5, opcode: 'stale', args: null, run: 'some-other-run' })
	check('log: an event for another run is dropped silently (no reply, not stored)', stale.timeout === true, JSON.stringify(stale))
	// The sender is not a participant of any game: nothing may land.
	outsider.socket.action('mpapi_log_event', { t: 1, opcode: 'evil', args: null, run: runId }, 'server')
	await sleep(500)

	// Odd but valid shapes: nested args, null args, a negative and a huge t.
	const events = [
		[1, 'start', { deck: 'b_red' }],
		[2, 'blind', ['bl_small', [1, -2, { a: null }]]],
		[3, 'nullargs', null],
		[-4, 'neg', 0],
		[1e15, 'huge', 'x'],
		[2.5, 'frac', { u: 'é "\\' }],
	]
	await sendLog(a.socket, runId, events)
	// A duplicate upload: same events again on top (a retry), and the closing
	// chk twice. The client's hash covers one copy, so this must read as mismatch
	// (or at least must not crash anything).
	await sendLog(b.socket, runId, [[1, 'start', {}]])
	await sendLog(b.socket, runId, [[1, 'start', {}]])
	await sleep(500)

	const ended = await finish(a, b, runId)
	check('log: game ended', !!ended, ended && JSON.stringify(ended.data.data))
	await sleep(1500)

	const rec = psql('nakama', `select value from storage where collection='match_runs' and key=${q(runId)}`)
	const run = rec.length ? JSON.parse(rec[0][0]) : null
	check('log: a is a hash match, b (duplicated upload) is flagged', run && run.logChecks[a.userId] === 'match' && run.logChecks[b.userId] === 'mismatch', run && JSON.stringify(run.logChecks))
	const la = await logsOf(a, runId, { playerId: a.userId })
	const stored = la.ok && la.body.logs[a.userId]
	check('log: odd shapes stored intact, tuple order kept', stored && stored.eventCount === events.length + 1 && JSON.stringify(stored.events.slice(0, events.length)) === JSON.stringify(events), stored && JSON.stringify(stored.events).slice(0, 200))
	check('log: the evil outsider event is in nobody\'s log', !JSON.stringify(la.body).includes('evil'), '')
	const lb = await logsOf(b, runId, { playerId: b.userId })
	check('log: duplicate upload stored twice (dup events + 2 chk)', lb.ok && lb.body.logs[b.userId].eventCount === 4, lb.ok && String(lb.body.logs[b.userId].eventCount))

	// --- after the match ended ---------------------------------------------------
	const late = await a.socket.ask('mpapi_log_event', { t: 9, opcode: 'late', args: null, run: runId })
	console.log(`  info: upload after the game ended -> ${JSON.stringify(late)}`)
	check('log: an upload after the game ended is refused or dropped', !!late.rejected || late.timeout || late.params === null, JSON.stringify(late))
	await sleep(500)
	const again = await logsOf(a, runId, { playerId: a.userId })
	check('log: stored log unchanged after the late upload', again.ok && again.body.logs[a.userId].eventCount === events.length + 1 && !JSON.stringify(again.body).includes('late'))

	// --- who may read ------------------------------------------------------------
	const g = await rpc(outsider.token, 'run_get', { runId })
	check('read: non-participant run_get -> 404', g.status === 404, `${g.status} ${g.text.slice(0, 80)}`)
	const l = await logsOf(outsider, runId)
	check('read: non-participant run_logs -> 404', l.status === 404, `${l.status} ${l.text.slice(0, 80)}`)
	const l2 = await logsOf(outsider, runId, { playerId: a.userId })
	check('read: non-participant run_logs with playerId -> 404', l2.status === 404, `${l2.status}`)
	const mineO = await rpc(outsider.token, 'runs_mine', {})
	check('read: non-participant runs_mine does not list it', mineO.ok && !JSON.stringify(mineO.body).includes(runId), mineO.text.slice(0, 100))
	const mineA = await rpc(a.token, 'runs_mine', {})
	check('read: participant runs_mine lists it', mineA.ok && JSON.stringify(mineA.body).includes(runId))
	const nof = await logsOf(a, 'does-not-exist')
	check('read: unknown run -> 404', nof.status === 404, `${nof.status}`)
	const noId = await rpc(a.token, 'run_logs', {})
	check('read: missing runId -> 400', noId.status === 400, `${noId.status} ${noId.text.slice(0, 80)}`)
	const numId = await rpc(a.token, 'run_logs', { runId: 5 })
	check('read: numeric runId -> 400', numId.status === 400, `${numId.status}`)
	const stranger = await logsOf(a, runId, { playerId: outsider.userId })
	check('read: playerId of a non-participant returns no logs', stranger.ok && Object.keys(stranger.body.logs).length === 0, stranger.text.slice(0, 100))
	const badCursor = await rpc(a.token, 'runs_mine', { cursor: 'garbage' })
	check('read: garbage runs_mine cursor -> 400', badCursor.status === 400, `${badCursor.status}`)
	const noAuth = await rpc(null, 'run_logs', { runId })
	check('read: unauthenticated run_logs refused', !noAuth.ok, `${noAuth.status}`)
	const asAdmin = await admin('run_logs', { runId })
	check('read: run_logs with the http key and no user refused', !asAdmin.ok, `${asAdmin.status}`)

	// --- mirror ------------------------------------------------------------------
	const mirrored = await poll(() => psql('bmp', `select count(*) from match_run_logs where run_id=${q(runId)}`)[0][0] === '2', 40000)
	check('mirror: both logs reached match_run_logs', mirrored)
	const row = psql('bmp', `select l.compressed_events, l.event_count, l.status, l.flag_reason, l.expires_at is null from match_run_logs l join players p on p.id::text=l.player_id where l.run_id=${q(runId)} and p.nakama_user_id=${q(a.userId)}`)
	if (row.length) {
		const decoded = JSON.parse(gunzipSync(Buffer.from(row[0][0], 'base64')).toString())
		check('mirror: compressedEvents is base64 gzip JSON of the tuples, in order', JSON.stringify(decoded.slice(0, events.length)) === JSON.stringify(events), JSON.stringify(decoded).slice(0, 160))
		check('mirror: event_count matches and the clean run expires', row[0][1] === String(events.length + 1) && row[0][4] === 'f', JSON.stringify(row[0].slice(1)))
	} else check('mirror: a row for a exists', false)
	const flagged = psql('bmp', `select l.flag_reason, l.expires_at is null from match_run_logs l join players p on p.id::text=l.player_id where l.run_id=${q(runId)} and p.nakama_user_id=${q(b.userId)}`)
	check('mirror: the mismatched log is flagged and has no expiry', flagged.length === 1 && flagged[0][0] === 'hash_mismatch' && flagged[0][1] === 't', JSON.stringify(flagged))

	for (const p of [a, b, outsider]) p.socket.close()
	return { runId, a, b }
}

async function byteCapScenario() {
	const [a, b] = [await player('ba'), await player('bb')]
	await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	const chunk = 'z'.repeat(15000)
	const before = a.socket.mark()
	for (let i = 0; i < 80; i++) {
		a.socket.action('mpapi_log_event', { t: i, opcode: 'fat', args: chunk, run: runId })
		if (i % 10 === 9) await sleep(600) // stay inside the 20/s log budget
	}
	await sleep(1000)
	const rejected = a.socket.inbox.slice(before).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED).length
	await sendLog(a.socket, runId, [[1, 'after', null]])
	await finish(a, b, runId)
	await sleep(1500)
	const l = await logsOf(a, runId, { playerId: a.userId })
	const log = l.ok && l.body.logs[a.userId]
	check('bytecap: 80 x 15 KB events: none rejected', rejected === 0, `${rejected} rejected`)
	check('bytecap: stored log is truncated under 1 MB (about 69 events)', log && log.truncated === true && log.eventCount >= 60 && log.eventCount <= 70, log && `${log.eventCount} truncated=${log.truncated}`)
	check('bytecap: truncated log check is unavailable, not mismatch', log && log.check === 'unavailable', log && log.check)
	a.socket.close()
	b.socket.close()
}

async function retentionScenario() {
	// An honest run and a flagged one, both made to look a year old, then purged.
	const [e, f] = [await player('rc'), await player('rd')]
	await lobbyWith([e, f])
	const { runId: cleanRun } = await startGame([e, f], {})
	await sendLog(e.socket, cleanRun, [[1, 'start', {}]])
	await sendLog(f.socket, cleanRun, [[1, 'start', {}]])
	await finish(e, f, cleanRun)
	for (const p of [e, f]) p.socket.close()
	const first = { runId: cleanRun }
	const [c, d] = [await player('ra'), await player('rb')]
	await lobbyWith([c, d])
	const { runId: flaggedRun } = await startGame([c, d], {})
	await sendLog(c.socket, flaggedRun, [[1, 'start', {}]], { tamper: true })
	await sendLog(d.socket, flaggedRun, [[1, 'start', {}]])
	await finish(c, d, flaggedRun)
	for (const p of [c, d]) p.socket.close()
	await sleep(1500)
	const old = Date.now() - 400 * 24 * 3600 * 1000
	for (const id of [first.runId, flaggedRun]) {
		psql('nakama', `update storage set value = jsonb_set(value, '{endedAt}', to_jsonb(${old}::bigint)) where collection='match_runs' and key=${q(id)}`)
	}
	// Not our run: confirm nothing else old exists that a purge would take.
	const others = psql('nakama', `select key from storage where collection='match_runs' and (value->'flags' is null or value->'flags'='{}'::jsonb) and value->>'status' <> 'disputed' and (value->>'endedAt')::bigint < ${Date.now() - 180 * 24 * 3600 * 1000} and key not in (${q(first.runId)}, ${q(flaggedRun)})`)
	if (others.length) {
		console.log(`  skip: ${foreign.length} other old runs exist, purge not run`)
		return
	}
	const purged = await admin('admin_runs_purge', {})
	check('retention: purge deleted the old unflagged run only', purged.ok && purged.body.deleted === 1, purged.text)
	const left = psql('nakama', `select key from storage where collection in ('match_runs') and key in (${q(first.runId)}, ${q(flaggedRun)})`).map((r) => r[0])
	check('retention: flagged old run kept, clean old run gone', left.length === 1 && left[0] === flaggedRun, JSON.stringify(left))
	const logsLeft = psql('nakama', `select count(*) from storage where collection='match_logs' and key like ${q(first.runId + ':%')}`)[0][0]
	check('retention: purged run left no logs', logsLeft === '0', logsLeft)
	const bad = await admin('admin_runs_purge', { olderThanDays: 0 })
	check('retention: olderThanDays 0 -> 400', bad.status === 400, `${bad.status}`)
	const noKey = await admin('admin_runs_purge', {}, 'wrong')
	check('retention: wrong http key refused', !noKey.ok, `${noKey.status}`)
	const asPlayer = await rpc(c.token, 'admin_runs_purge', {})
	check('retention: a player may not purge', !asPlayer.ok, `${asPlayer.status}`)
}

// A player's lobby seat, as the reconnect prompt reads it.
const current = (p) => rpc(p.token, 'lobby_current', {})
const active = (p) => rpc(p.token, 'run_active', {})

async function rejoinScenario() {
	const [a, b, stranger] = [await player('ja'), await player('jb'), await player('js')]
	const lob = await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	for (let i = 0; i < 5; i++) b.socket.action('mpapi_log_event', { t: i, opcode: 'ev', args: i, run: runId })
	await sleep(500)
	b.socket.close()
	await sleep(1000)
	const act = await active(b)
	check('rejoin: run_active while away returns the run and the log so far', act.ok && act.body.active && act.body.active.runId === runId && act.body.active.events.length === 5, act.text.slice(0, 160))
	const cur = await current(b)
	check('rejoin: lobby_current returns the seat', cur.ok && cur.body.code === lob.code, cur.text.slice(0, 120))

	// A different account cannot take the seat or join the running game.
	const joinS = await (await connect(stranger)).join(lob.matchId, { modId: lob.modId, displayName: 'x' })
	check('rejoin: another account cannot join the running game', !!joinS.error, JSON.stringify(joinS).slice(0, 200))
	const specAct = await active(stranger)
	check('rejoin: another account has no active run', specAct.ok && specAct.text === '{}', specAct.text)

	// Two rejoins at once (two sockets, same account).
	const [s1, s2] = [await connect(b), await connect(b)]
	const [j1, j2] = await Promise.all([s1.join(lob.matchId, { modId: lob.modId }), s2.join(lob.matchId, { modId: lob.modId })])
	await sleep(1500)
	console.log(`  info: simultaneous rejoin results: ${JSON.stringify(j1).slice(0, 100)} | ${JSON.stringify(j2).slice(0, 100)}`)
	const okCount = [j1, j2].filter((j) => !j.error).length
	const open = [s1, s2].filter((s) => !s.closed).length
	check('rejoin: two simultaneous rejoins leave a working seat', okCount >= 1 && open >= 1, `ok=${okCount} open=${open}`)
	const live = [s1, s2].find((s) => !s.closed)
	b.socket = live
	const snap = live && (await live.waitFor((x) => x.kind === 'data' && x.op === ServerOp.SNAPSHOT, 3000))
	check('rejoin: the live socket got a snapshot with the game started', snap && snap.data.game.started && snap.data.players.every((p) => !p.isAway), snap && JSON.stringify(snap.data.players).slice(0, 200))
	const dups = snap && snap.data.players.filter((p) => p.id === b.userId).length
	check('rejoin: b is seated exactly once', dups === 1, String(dups))
	check('rejoin: a saw b come back', !!(await a.socket.waitFor(isEvent('player_reconnected'), 3000)) || !!(await a.socket.waitFor(isEvent('player_joined'), 100)), JSON.stringify(a.socket.inbox.filter((x) => x.kind === 'data' && x.op === ServerOp.EVENT).map((x) => x.data.type)))

	// Log upload continues after the rejoin and the hash still matches.
	await live.ask('mpapi_log_event', { t: 9, opcode: 'afterjoin', args: null, run: runId })
	const evs = []
	for (let i = 0; i < 5; i++) evs.push([i, 'ev', i])
	evs.push([9, 'afterjoin', null])
	const carbon = sha256Hex(`[${evs.map((e) => JSON.stringify(e)).join(',')}]`)
	live.action('mpapi_log_event', { t: 99999, opcode: 'chk', args: { carbon }, run: runId })
	await sleep(500)

	// Old session replaced: an older socket of a, a new one for a.
	const a2 = await connect(a)
	const ja2 = await a2.join(lob.matchId, { modId: lob.modId })
	await sleep(1000)
	console.log(`  info: a's second session: ${JSON.stringify(ja2).slice(0, 120)}; old socket closed=${a.socket.closed}`)
	const a1Dead = a.socket.closed
	check('rejoin: a second session for a seated, connected player is refused or replaces the first', !!ja2.error || a1Dead, `error=${!!ja2.error} oldClosed=${a1Dead}`)
	const aSock = ja2.error ? a.socket : a2
	a.socket = aSock

	const ended = await (async () => {
		const since = a.socket.mark()
		await a.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
		await b.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
		return a.socket.waitFor(isEvent('game_ended'), 10000, since)
	})()
	check('rejoin: game ends agreed after the rejoin', ended && ended.data.data.status === 'agreed', ended && JSON.stringify(ended.data.data))
	await sleep(1500)
	const rec = psql('nakama', `select value->'logChecks' from storage where collection='match_runs' and key=${q(runId)}`)
	const checks = rec.length ? JSON.parse(rec[0][0]) : {}
	const lb = await logsOf(a, runId, { playerId: b.userId })
	console.log(`  info: b log after rejoin: ${lb.ok && lb.body.logs[b.userId].eventCount} events, check ${checks[b.userId]}`)
	check('rejoin: b log kept across the rejoin (6 events + chk)', lb.ok && lb.body.logs[b.userId].eventCount === 7, lb.text.slice(0, 120))
	check('rejoin: b log still hash-matches', checks[b.userId] === 'match', JSON.stringify(checks))
	const after = await active(b)
	check('rejoin: no active run once the game ended', after.ok && after.text === '{}', after.text)
	for (const s of [a.socket, b.socket, stranger.socket, s1, s2, a2]) s.close()
}

async function closedLobbyScenario() {
	const [a, b] = [await player('ca'), await player('cb')]
	const lob = await lobbyWith([a, b])
	await startGame([a, b], {})
	// Both leave for good: the lobby closes.
	a.socket.sendOp(1, {})
	b.socket.sendOp(1, {})
	await sleep(2500)
	const probe = await connect(b)
	const j = await probe.join(lob.matchId, { modId: lob.modId })
	check('closed: joining a closed lobby is refused or has no match', !!j.error, JSON.stringify(j).slice(0, 160))
	const act = await active(b)
	const cur = await current(b)
	check('closed: run_active empty after leaving', act.ok && act.text === '{}', act.text)
	check('closed: lobby_current empty after leaving', cur.ok && cur.text === '{}', cur.text)
	const lv = await rpc(b.token, 'lobby_leave', {})
	check('closed: lobby_leave with no lobby is a harmless no-op', lv.ok, lv.text)
	const rec = psql('nakama', `select count(*) from storage where collection='match_runs' and (value->'players') @> ${q(JSON.stringify([{ id: a.userId }]))}::jsonb`)
	check('closed: a game everyone left is stored as a run', rec[0][0] === '1', rec[0][0])
	probe.close()
	a.socket.close()
	b.socket.close()
}

async function forfeitScenario() {
	const [a, b] = [await player('fa'), await player('fb')]
	const lob = await lobbyWith([a, b])
	const { runId } = await startGame([a, b], {})
	b.socket.close()
	const t0 = Date.now()
	// Within the grace: still seated.
	await sleep(30000)
	const mid = await active(b)
	check('forfeit: 30 s in, b still has an active run', mid.ok && !!mid.body.active, mid.text.slice(0, 100))
	const left = await a.socket.waitFor((x) => x.kind === 'data' && x.op === ServerOp.EVENT && x.data.type === 'player_left', 150000)
	const graceS = (Date.now() - t0) / 1000
	check('forfeit: b removed after ~120 s', !!left && graceS >= 115 && graceS < 135, `${graceS.toFixed(1)}s`)
	const act = await active(b)
	check('forfeit: run_active is empty after the forfeit', act.ok && act.text === '{}', act.text)
	const cur = await current(b)
	check('forfeit: lobby_current is empty after the forfeit', cur.ok && cur.text === '{}', cur.text)
	const probe = await connect(b)
	const j = await probe.join(lob.matchId, { modId: lob.modId })
	check('forfeit: rejoining after the forfeit is refused', !!j.error, JSON.stringify(j).slice(0, 160))
	// Fire and forget: with nobody left to relay to, there is no reply.
	a.socket.action('mpapi_log_event', { t: 1, opcode: 'x', args: null, run: runId })
	await sleep(500)
	const since = a.socket.mark()
	await a.socket.ask('mpapi_report_result', { placements: placementsOf([a, b]) })
	const ended = await a.socket.waitFor(isEvent('game_ended'), 70000, since)
	check('forfeit: lone reporter ends it', !!ended, ended && JSON.stringify(ended.data.data).slice(0, 120))
	await sleep(1500)
	const bl = await logsOf(b, runId, { playerId: b.userId })
	const al = await logsOf(a, runId, { playerId: a.userId })
	check('forfeit: the remaining player upload after the forfeit was stored', al.ok && al.body.logs[a.userId].eventCount === 1, al.text.slice(0, 120))
	check('forfeit: the forfeited player can still fetch their own (empty) replay', bl.ok, bl.text.slice(0, 120))
	const mine = await rpc(b.token, 'runs_mine', {})
	check('forfeit: the forfeited player lists the run', mine.ok && JSON.stringify(mine.body).includes(runId), mine.text.slice(0, 120))
	probe.close()
	a.socket.close()
}

async function spectateScenario() {
	const [a, b, s] = [await player('sa'), await player('sb'), await player('ss')]
	const lob = await lobbyWith([a, b])
	a.socket.sendOp(3, { metadata: { spectatable: true } })
	await sleep(500)
	const { runId } = await startGame([a, b], {})
	await sendLog(a.socket, runId, [[1, 'lobby_info', { gamemode: 'g', ruleset: 'r', options: {} }], [2, 'run_info', { seed: 'SEED', deck: 'b_red', stake: 2 }], [3, 'set_ante_key', ['2']]])
	await sleep(600)
	const sock = await connect(s)
	s.socket = sock
	const joined = await sock.join(lob.matchId, { role: 'spectator', modId: lob.modId })
	const snap = await sock.waitFor((x) => x.kind === 'data' && x.op === 108, 3000)
	const entry = snap && snap.data.snapshot.find((e) => e.playerId === a.userId)
	check('spectate: a late spectator gets the log-derived snapshot', !joined.error && entry && entry.ante === '2' && entry.manifest && entry.manifest.seed === 'SEED', snap && JSON.stringify(snap.data).slice(0, 200))
	const before = sock.mark()
	a.socket.action('mpapi_log_event', { t: 10, opcode: 'set_ante_key', args: ['3'], run: runId })
	const ev = await sock.waitFor((x) => x.kind === 'data' && x.op === 109, 3000, before)
	check('spectate: a later event reaches the spectator', !!ev && ev.data.opcode === 'set_ante_key', ev && JSON.stringify(ev.data))
	// A spectator's own upload is ignored: it never lands in any log.
	const before2 = b.socket.mark()
	sock.action('mpapi_log_event', { t: 11, opcode: 'spectator_evil', args: null, run: runId })
	await sleep(600)
	check('spectate: a spectator upload reaches no player', !b.socket.inbox.slice(before2).some((x) => JSON.stringify(x).includes('spectator_evil')))
	await finish(a, b, runId)
	await sleep(1500)
	const l = await logsOf(a, runId)
	check('spectate: the spectator upload is in no stored log', l.ok && !JSON.stringify(l.body).includes('spectator_evil'), l.text.slice(0, 100))
	const sl = await logsOf(s, runId)
	check('spectate: a spectator cannot fetch the logs (participants only)', sl.status === 404, `${sl.status}`)
	for (const p of [a, b, s]) p.socket.close()
}

async function pagingScenario() {
	// 22 short games in one lobby: runs_mine pages newest first, 20 at a time.
	const [a, b] = [await player('pa'), await player('pb')]
	await lobbyWith([a, b])
	const ids = []
	for (let i = 0; i < 22; i++) {
		const { runId } = await startGame([a, b], {})
		ids.push(runId)
		a.socket.action('mpapi_log_event', { t: 1, opcode: 'n', args: i, run: runId })
		await finish(a, b, runId)
		await sleep(150)
	}
	const first = await rpc(a.token, 'runs_mine', {})
	const got1 = first.ok ? first.body.runs.map((r) => r.runId) : []
	check('paging: first page holds 20 runs, newest first', got1.length === 20 && got1[0] === ids[21] && got1[19] === ids[2], `${got1.length} first=${got1[0] === ids[21]}`)
	const second = first.ok && first.body.cursor ? await rpc(a.token, 'runs_mine', { cursor: first.body.cursor }) : null
	const got2 = second && second.ok ? second.body.runs.map((r) => r.runId) : []
	check('paging: second page holds the 2 oldest, no overlap', got2.length === 2 && got2[0] === ids[1] && got2[1] === ids[0], JSON.stringify(got2))
	const bogus = await rpc(b.token, 'runs_mine', { cursor: first.body.cursor })
	console.log(`  info: a's cursor used by b -> ${bogus.status} ${bogus.text.slice(0, 120)}`)
	check('paging: another player\'s cursor lists only their own runs', bogus.status === 400 || (bogus.ok && bogus.body.runs.every((r) => ids.includes(r.runId))), `${bogus.status}`)
	for (const p of [a, b]) p.socket.close()
}

async function burstScenario() {
	// Nakama's match input queue holds 128 messages per tick (5/s) for the whole
	// lobby, and drops the rest silently (no rejection). A burst under it is
	// kept whole; a bigger one loses its tail, including the closing 'chk'.
	// The second half only reports what happens (KNOWN ISSUE), it does not fail.
	const [a, b, c, d] = [await player('ua'), await player('ub'), await player('uc'), await player('ud')]
	await lobbyWith([a, b])
	const small = (await startGame([a, b], {})).runId
	await sendLog(a.socket, small, Array.from({ length: 100 }, (_, i) => [i, 'burst', i]))
	await sleep(1000)
	await finish(a, b, small)
	await sleep(1500)
	const la = await logsOf(a, small, { playerId: a.userId })
	check('burst: 100 events at once are all kept and the log matches', la.ok && la.body.logs[a.userId].eventCount === 101 && la.body.logs[a.userId].check === 'match', la.ok && JSON.stringify([la.body.logs[a.userId].eventCount, la.body.logs[a.userId].check]))
	await lobbyWith([c, d])
	const big = (await startGame([c, d], {})).runId
	const before = c.socket.mark()
	await sendLog(c.socket, big, Array.from({ length: 260 }, (_, i) => [i, 'burst', i]))
	await sleep(1500)
	const refused = c.socket.inbox.slice(before).filter((i) => i.kind === 'data' && i.op === ServerOp.ACTION_REJECTED).length
	await finish(c, d, big)
	await sleep(1500)
	const lc = await logsOf(c, big, { playerId: c.userId })
	const l = lc.ok && lc.body.logs[c.userId]
	console.log(`  info: KNOWN ISSUE: 261 events in one go: ${refused} refused, ${l.eventCount} stored, check ${l.check}`)
	for (const p of [a, b, c, d]) p.socket.close()
}

async function main() {
	await Promise.all([logScenario(), byteCapScenario(), rejoinScenario(), closedLobbyScenario(), forfeitScenario(), spectateScenario(), pagingScenario(), burstScenario()])
	await retentionScenario()
	process.exit(summary('replays-rejoin') ? 1 : 0)
}

main().catch((e) => {
	console.error(e)
	process.exit(2)
})
